# Embedded Zotero Note Image Synchronization

## Scope and safety boundary

This design extends one-way child-note synchronization with opt-in embedded
image upload. It reads standard Zotero 10 embedded-image attachments through
supported Zotero APIs and sends the bytes directly to Notion's official File
Upload API. It does not read Zotero's SQLite database, construct storage paths,
publish a temporary URL, or modify source Zotero data.

`NoteroPref.syncNoteImages` defaults to `false`. Automated tests use synthetic
HTML and image fixtures. A real Zotero 10 multipart smoke test is deliberately
left to a dedicated development profile and test-only Notion workspace.

## Call paths

An automatic note update follows this path:

1. `Notero.start()` starts `EventManager` and `SyncManager`.
2. `EventManager.notify()` converts a Zotero `item/modify` notification to an
   internal event.
3. `SyncManager.handleNotifierEvent()` filters and queues eligible item IDs.
4. `SyncManager.performSync()` calls `performSyncJob()`.
5. `performSyncJob()` creates the Notion client and calls `syncItems()`.
6. `syncItems()` dispatches child notes to `syncNoteItem()`.

The content path is:

```text
noteItem.getNote()
  -> findEmbeddedImages() and sequential local validation
  -> convertHtmlToBlocks() ordered block normalization
  -> provisional File Upload preparation
  -> durable candidate transaction
  -> verified active-block replacement
```

`withNoteSyncLock()` serializes by library plus parent item and then by library
plus note item. Metadata snapshots are read only after the locks are acquired.

## Ordered parser representation

`parseNode()` represents `IMG` explicitly. `convertHtmlToBlocks()` preserves
ordered text/image boundaries through inline wrappers. Because Notion does not
support true inline images, an inline sequence is normalized to blocks:

```text
text segment -> image block -> text segment
```

This normalization applies to paragraphs, headings, list items, quotes,
anchors, spans, strong text, and nested inline wrappers. An `IMG` reaching a
rich-text-only converter is an error; it is never converted to an empty array.
Unsupported structures stop conversion before a candidate is created.

Before candidate creation, `syncNoteItem()` compares four occurrence counts:

- supported images discovered by the parser;
- local images resolved and validated;
- prepared File Upload references;
- rendered Notion image blocks.

All four must be equal. This prevents a new source hash from being committed
with missing image blocks.

## Local image resolution and validation

`resolveNoteImage()` performs read-only checks:

1. resolve by `Zotero.Items.getByLibraryAndKey(note.libraryID, key)`;
2. require the same library, source-note parent, embedded-image attachment type,
   and a non-deleted item;
3. obtain the supported path through `getFilePathAsync()` and read with
   `IOUtils.read()`;
4. enforce the connected workspace and direct-upload size limit;
5. structurally validate PNG, JPEG, GIF, or WebP bytes and decode them through
   the Zotero main-window image decoder;
6. hash valid bytes with SHA-256 from the Zotero main-window realm.

Raster validation rejects header-only, truncated, length-inconsistent, and
forged-MIME files. SVG is intentionally unsupported in this release candidate;
APNG, AVIF, BMP, and unknown formats are also unsupported. Each rejected format
causes note sync to stop with the previous valid block unchanged.

## Zotero Web API realm

`zotero-web-api.ts` obtains `Blob`, `FormData`, `DOMParser`, text codecs,
`crypto.subtle`, and `crypto.randomUUID()` from the Zotero main window. The
Notion SDK is configured with the same Blob/FormData constructors and the
client receives the bound main-window `fetch`. Tests replace the window realm
with constructors that reject foreign objects so Node/jsdom globals cannot
silently satisfy the adapter contract.

Real Gecko multipart compatibility still requires the isolated Zotero 10 plus
test Notion smoke test documented in the manual checklist.

## Notero-managed block ownership

A bare Notion block ID is never mutation authority. New canonical containers,
active note headings, and candidate headings contain a separate, machine-owned
rich-text marker. The marker is stable and opaque; it is recomputed from:

- block kind;
- Notion connection/bot, workspace, database, and page identity;
- Zotero library identity;
- parent item identity;
- note identity for note/candidate blocks;
- attempt identity for candidate blocks.

It contains no token, note text, image bytes, or local path. It is not treated
as a secret or bearer credential. Before deletion, promotion, replacement, or
recovery, verification also requires:

- the metadata marker to equal the independently recomputed marker;
- the response block ID to equal the referenced ID;
- a live toggleable `heading_1` block;
- the exact page/container parent;
- `created_by.id` to equal the current Notion bot identity;
- exactly one invisible U+2063 rich-text token whose `text.link.url` and
  returned `href` exactly equal the independently reconstructed marker URL.

The ASCII ownership identity is URL-encoded in the invisible token's link and
never enters title `plain_text`. Prefix/suffix edits, a changed or missing link,
duplicate marker segments, and a merged marker/title segment all fail closed.
Candidate ownership is revalidated after content append and again before the
active block is deleted.

Legacy `containerBlockID`, `blockID`, `candidate.blockID`, and
`orphanBlockIDs` remain readable for diagnostics and links, but are tagged
`legacy-unverified`. They cannot authorize adoption, deletion, promotion, or
cleanup. A note with such state stops with an actionable ownership error. No
unknown remote block is modified automatically. Instead, Notero creates a new
marked canonical container and complete managed copies, keeps every legacy
block unchanged as evidence, and displays a notice that duplicates may remain
until the user reviews them manually. Subsequent syncs reuse the managed v2
mapping and do not create another copy.

## Canonical container

The `Zotero Notes` container has its own parent-scoped ownership marker and is
verified against the Notion page. A note block's current parent never replaces
the global container mapping. If a user moves a note under another block, that
note stops as unverified; other notes continue to use the original verified
canonical container.

## Durable transaction journal

Schema version 2 stores a note transaction before the first remote File Upload
or block write. The transaction has a stable attempt ID, source hash, complete
target identity, expected/resolved/prepared/rendered image counts, managed
container/candidate references, previous active reference, timestamps, and a
stage. Remote IDs are saved immediately after they are known.

Stages include:

```text
prepared
container-create-uncertain -> container-created
candidate-create-uncertain -> candidate-created
content-partial -> content-complete
title-finalized -> candidate-persisted
old-delete-confirmed -> promotion
orphan-cleanup
```

The canonical container and candidate carry attempt-specific remote markers,
allowing a new process with no in-memory state to list and reconcile an
uncertain create. Each uncertain block create persists a two-minute deadline.
Reconciliation accepts exactly one parent-, marker-, type-, and creator-matched
block within bounded pagination. Multiple matches stop safely. Zero matches
wait before the deadline; one final exhaustive zero-match reconciliation after
the deadline clears the attempt so a later synchronization can create once.
HTTP 400 validation, 401, and 403 responses roll the journal back to the safe
pre-create stage because those requests are proven unexecuted.

Incomplete candidates are verified and removed on restart where deletion can
be positively confirmed. A recovered `candidate-created` block is resumed only
after a child listing proves that no append was left unjournaled. A
`candidate-persisted` record contains the completed replacement and permits
old-block deletion to resume. `old-delete-confirmed` means the complete
candidate is already the only last-known-good version: it is promoted under
its old source hash before any changed-source transaction starts and cannot be
deleted until the changed source commits. A half-written candidate is never
promoted.

If the source changes during recovery, the old transaction is handled only by
its persisted target, source identity, attempt marker, candidate, orphan, and
upload evidence. Verified candidates enter bounded cleanup. An unverifiable
candidate is never mutated; after five attempts it moves to bounded
`unverifiedOrphanBlocks` evidence so a fresh transaction can safely synchronize
the current source. Each recovery run processes at most four orphan blocks and
persists progress after each confirmed deletion.

## Delete uncertainty and 404

Notion 404 responses cannot distinguish a missing block from a block hidden by
connection permissions. Consequently:

- retrieval 404 is `uncertain`, never `absent`;
- delete confirmation requires the delete response itself to contain the exact
  block ID and `in_trash: true`;
- a lost delete response followed by 404 remains uncertain;
- the active mapping and completed candidate recovery record are preserved;
- promotion waits for positive evidence or manual reconciliation.

Delete, append, and update mutations are not blindly replayed after ambiguous
outcomes.

## Provisional File Upload journal

Provisional uploads are separate from the formal active note image mapping.
Each entry binds:

- Notion connection, workspace, database, and page;
- Zotero library, parent item, note item, and attachment;
- content hash, content type, content length, and deterministic filename;
- attempt ID, upload ID when known, status, request start, isolation deadline,
  creation time, and expiry.

The journal exists before upload creation and uses explicit `prepared`,
`create-uncertain`, `created-unsent`, `send-uncertain`, `uploaded`, `attached`,
`failed`, and `expired` states. A returned upload ID first becomes
`created-unsent`; bounded local journal retries must succeed before `send` may
start. A restarted `created-unsent` upload may be sent exactly once, while a
`send-uncertain` upload is retrieve-only and never replays bytes. Expired and
failed IDs are not reused.

For a create response lost before the ID is known, the service uses the
official `fileUploads.list()` API and accepts only one recent exact match for
the deterministic filename, connection-owned list, content type, content
length, and creation-time window. It never guesses among zero or multiple
matches. If the platform cannot prove the create result, the journal remains
`create-uncertain` and a conservative 65-minute quarantine prevents blind
recreation. This is a platform safety limitation, not strong create
idempotency.

Official Notion documentation states that unattached uploads expire, while an
attached uploaded ID has no expiry and may continue to be reused. After every
successful append batch, referenced upload IDs are persisted as `attached`
with `attachedAt`, null expiry, target, attachment, and content identity. An
ambiguous append is not marked attached unless retrieve proves the upload has
become non-expiring. Candidate cleanup cannot discard this permanent cache.

## Retry policy

Safe reads and only create failures classified as proven unexecuted use at most
three attempts and a maximum total wait of 30 seconds. HTTP 429 prefers
`Retry-After` (delta seconds or HTTP date). Invalid or missing headers fall
back to bounded exponential backoff with jitter. HTTP 500, 502, 503, 504, 529,
timeouts, and network interruptions are result-uncertain creates: they are
never replayed and instead enter bounded list reconciliation plus a persisted
65-minute isolation window. HTTP 401 and 403 are not retried.

Mutation classes are explicit:

- safe read/create retry where the API outcome is known;
- uncertain write with no blind replay;
- retrieve/list reconciliation for create/send outcomes;
- positive response-only confirmation for deletion.

Tests inject the clock, sleeper, and random source; they perform no real wait.

## Feature-off compatibility

When image synchronization is disabled, Notero does not:

- scan attachment descriptors;
- resolve attachment items or read image files;
- create/send/retrieve/list File Uploads;
- call `users.me()`, including for a legacy manual token that lacks connection
  and workspace identity;
- persist `images`, image `target`, or provisional upload state in the final
  note mapping.

OAuth identity is reused when available. Otherwise, Feature OFF uses a stable
random local target ID stored in preferences. If that local write fails, a
domain-separated token fingerprint is used only as a fail-closed fallback; it
is not represented as a real workspace identity, and raw tokens never enter
metadata, markers, or logs. The creator returned with each newly managed block
is stored in its reference and remains mandatory for later verification, so
the local target identity does not weaken creator checks. The text block
conversion remains the existing text-only behavior. The general ownership and
durable replacement protections apply to both modes because they prevent
unsafe note-block deletion.

## Resource limits

The defaults are 32 image occurrences and 100 MiB aggregate image bytes per
note, in addition to the per-file Notion/direct-upload limit. Local validation
is sequential. Bytes are released after preflight, then one file is re-read,
rehash-checked, uploaded, and released before the next upload. Upload
concurrency is one.

## Metadata recovery

The hidden `notero-synced-notes` payload has `schemaVersion: 2`. Records are
parsed per note and optional subfields are parsed independently. Corrupt image
cache, candidate, orphan, provisional-upload, or transaction data is
quarantined and cannot authorize mutation. A valid active mapping can remain
available. Healthy sibling notes continue to load.

Diagnostics retain a redacted path/reason/value-shape summary. Unknown fields
within supported schemas are preserved on save. A schema version newer than v2
is retained verbatim as an unsupported read-only record; sync and save stop
before any local or remote mutation. Malformed root JSON remains a global stop
because no record boundary can be established safely.

## Automated coverage

- ownership attacks using user, other-note, other-container, other-page, and
  other-bot blocks;
- inline wrapper and parser-to-block ordering, multiple images, and render-count
  mismatch rejection;
- restart at every container/candidate/append/title/delete/promotion/orphan
  stage;
- permission-hidden 404 and ambiguous deletion;
- partial, ambiguous, expired, failed, and restarted File Upload lifecycles;
- canonical-container isolation after a note is moved;
- per-note metadata corruption and future/legacy schema handling;
- main-window realm adapters and multipart object construction;
- `Retry-After`, jittered bounded retry, non-retryable auth errors, and budgets;
- feature-off request and metadata behavior;
- real minimal raster fixtures, corrupt variants, decoder rejection, and
  explicit SVG/APNG/AVIF/BMP rejection;
- image count, aggregate size, serial upload, and bounded byte lifetime.

## Manual validation status

Not run. See `embedded-note-image-sync-manual-test.md`. No production Zotero
profile or Notion workspace may be substituted for the required isolated test
environment. This remediation does not generate or install an XPI.

## Source and API references

- `src/content/sync/sync-note-item.ts`: coordinator and recovery state machine
- `src/content/sync/notion-block-ownership.ts`: marker creation and verification
- `src/content/sync/notion-image-upload-service.ts`: upload lifecycle and retry
- `src/content/sync/note-image-resolver.ts`: local validation and hashing
- `src/content/sync/zotero-web-api.ts`: Zotero main-window Web API realm
- `src/content/sync/html-to-notion/`: ordered parser and block conversion
- `src/content/data/item-data.ts`: schema-v2 persistence and diagnostics
- [Notion File Upload object](https://developers.notion.com/reference/file-upload)
- [Create a file upload](https://developers.notion.com/reference/create-file)
- [Send a file upload](https://developers.notion.com/reference/upload-file)
- [List file uploads](https://developers.notion.com/reference/list-file-uploads)
- [Notion block object](https://developers.notion.com/reference/block)
