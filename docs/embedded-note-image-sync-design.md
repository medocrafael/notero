# Embedded Zotero Note Image Synchronization

## Scope and safety boundary

This design extends the existing one-way child-note synchronization. It reads
standard Zotero 10 embedded-image attachments and sends their bytes directly
to Notion's official File Upload API. It does not read Zotero's SQLite
database, construct storage paths, publish files through a URL, or modify any
source Zotero item. The feature is opt-in through
`NoteroPref.syncNoteImages`, whose default is `false`.

The implementation and automated tests use synthetic HTML and image bytes.
Manual validation must use a dedicated Zotero profile and a separate Notion
test database.

## Current call paths

An automatic note update follows this path:

1. `Notero.start()` in `src/content/notero.ts` starts `EventManager` and
   `SyncManager`.
2. `EventManager.notify()` in `src/content/services/event-manager.ts` converts
   Zotero's `item/modify` notification to the internal `item.modify` notifier
   event.
3. `SyncManager.handleNotifierEvent()` in
   `src/content/services/sync-manager.ts` filters deleted and disabled items,
   applies the collection configuration, and queues item IDs.
4. `SyncManager.performSync()` debounces queued work for two seconds and calls
   `performSyncJob()` in `src/content/sync/sync-job.ts`.
5. `performSyncJob()` creates a Notion client and retrieves the configured
   database schema. `syncItems()` dispatches child notes to `syncNoteItem()`.

Manual collection/item synchronization enters the same `SyncManager` queue
and `performSyncJob()` path. Two already-started jobs can overlap, so
`syncNoteItem()` must also serialize by Zotero library and note identity.

The pre-change content path was:

1. `syncNoteItem()` obtains the parent page ID and the metadata stored by
   `getSyncedNotes()` in `src/content/data/item-data.ts`.
2. `buildNoteBlockBatches()` calls `noteItem.getNote()`.
3. `convertHtmlToBlocks()` in
   `src/content/sync/html-to-notion/html-to-notion.ts` parses the HTML and
   converts it to Notion child-block requests.
4. `addNoteBlockContent()` appends batches of at most
   `LIMITS.BLOCK_ARRAY_ELEMENTS` through `notion.blocks.children.append()`.

The pre-change `syncNoteItem()` deletes the active block before replacement and
calls `saveSyncedNote()` in a `finally` block before content append finishes.
Those two behaviors are replaced by the state machine below.

## Zotero 10 image representation

Zotero 10 note HTML represents a standard embedded image as an `IMG` element
whose `data-attachment-key` is the key of an embedded-image attachment owned
by the note. PDF area annotations use the same attachment-key representation
and may add `data-annotation`. Images pasted or dropped into the editor, and
images created by another plugin through Zotero's standard embedded-image
API, use the same attachment relationship.

`parseNode()` in `src/content/sync/html-to-notion/parse-node.ts` gains an
explicit `ImageElement` variant. `findEmbeddedImages()` scans the same DOM in
document order and emits immutable descriptors containing the attachment key,
optional annotation metadata, and safe alt text. Missing keys and nonstandard
sources are represented as invalid descriptors and rejected when image sync
is enabled. With image sync disabled, the existing text-only conversion path
does not resolve or upload images.

## Ordered content representation

The existing `ContentResult` tree remains the intermediate representation for
text blocks and rich text. An image is a first-class block result, not rich
text. `convertHtmlToBlocks()` receives a map of prepared image references and
emits an image block exactly where the `IMG` occurred. Existing parent-block
normalization turns text before or after an image into surrounding paragraph
blocks while preserving DOM order. The same mechanism works inside list
items, quotes, and other supported parent blocks.

Each emitted Notion image has this request form:

```json
{
  "image": {
    "type": "file_upload",
    "file_upload": { "id": "<uploaded-file-id>" }
  }
}
```

## Local image resolution and validation

`resolveNoteImage()` in `src/content/sync/note-image-resolver.ts` performs the
following read-only checks:

1. Resolve with `Zotero.Items.getByLibraryAndKey(note.libraryID, key)`.
2. Require the resolved item to be in the same library, to be a child of the
   source note, to be non-deleted, and to satisfy
   `isEmbeddedImageAttachment()`.
3. Resolve the supported local path with `getFilePathAsync()` and read bytes
   once with `IOUtils.read()`.
4. Reject empty or oversized bytes before any upload.
5. Validate the declared `attachmentContentType` against a supported image
   allowlist and verify a matching byte signature for GIF, JPEG, PNG, SVG, or
   WebP. Zotero image formats outside Notion's official File Upload image
   allowlist are rejected before upload.
6. Compute a SHA-256 hex content hash with Web Crypto.

The resolver returns a `Uint8Array`; base64 is never used as persistent or
network-transfer state. Errors identify the synthetic note/attachment key and
stage but never log file bytes, note HTML, or an absolute local path.

The maximum is the smaller of Notion's direct single-part limit (20 MiB) and
the connected workspace's `max_file_upload_size_in_bytes`, obtained from
`notion.users.me()`. This project deliberately does not add multi-part upload
until a separately tested need exists.

## Notion target identity

`NotionAuthManager.getRequiredAuthContext()` and `prepareSyncJob()` build a
`NotionTarget` from:

- the stored OAuth bot/connection ID (or the authenticated user ID for a legacy
  token);
- the stored OAuth workspace ID (or the authenticated user ID for a legacy
  token);
- the configured database ID;
- the parent Notion page ID.

The target key never contains an access token. Every upload cache entry stores
that target identity. A cache hit requires equality of connection, workspace,
database, and page identity as well as attachment identity and content hash.
Changing any target component prevents reuse of a File Upload ID. Legacy token
fallbacks remain safe because Notion page and database IDs are globally scoped
and are still mandatory target components.

The checked-in OAuth exchange service only supplies a bearer token. The
installed SDK sends File Upload requests directly to `api.notion.com`, and
Notion does not define a separate OAuth scope for file uploads. No hosted
service change is required by the repository architecture. A test-connection
OAuth capability smoke test remains part of manual validation.

## Upload lifecycle, cache, and retry policy

`NotionImageUploadService` in
`src/content/sync/notion-image-upload-service.ts` uses the SDK lifecycle:

1. `fileUploads.create({ mode: 'single_part', filename, content_type })`;
2. `fileUploads.send({ file_upload_id, file: { data: Blob, filename } })`;
3. require an `uploaded` status, retrieving status when necessary;
4. attach the ID only through the candidate image block.

Official Notion documentation states that an uploaded ID may be reused after
it has been attached and remains reusable after the original block is removed.
The cache therefore stores only IDs that were successfully attached as part of
a complete candidate. Pending, expired, failed, or never-attached IDs are not
promoted to reusable cache state.

Authentication and authorization failures (401/403), invalid input, corrupt
files, unsupported MIME, and oversize failures are never retried. Upload
creation and status retrieval use at most three attempts for 409, 429, 529,
500, 502, 503, 504, timeout, or network errors, with bounded exponential delay.
The byte-send request is issued once; an ambiguous result is resolved by
retrieving the upload object. Block append and delete requests are also issued
once. A content-append ambiguity discards the whole known candidate. An
ambiguous candidate-creation response is searched by a unique staging title
with bounded child-list pagination before the operation fails. An ambiguous
delete is resolved through bounded block retrieval rather than repeated
deletion.

## Safe replacement state machine

Each note record has one active version plus optional recovery state:

```text
active(block ID, source hash, target, image cache)
  -> preflight complete
  -> candidate block created with a staging title
  -> every content batch appended exactly once
  -> candidate title finalized
  -> complete candidate recovery record persisted; active is unchanged
  -> old active block archived
  -> candidate promoted to active and recovery record cleared
```

The complete-candidate recovery record is not the formal mapping returned by
`getNotionURL()`. It exists solely to make a crash between remote operations
and metadata commits recoverable. Formal mapping promotion occurs only after
all uploads and block batches are complete and the old block is confirmed
archived.

On any pre-commit failure, the old active block and mapping remain unchanged.
The candidate is archived where safe. If cleanup fails, its ID is recorded as
an orphan and the next synchronization performs a bounded cleanup before
starting another candidate. First-time failures use the same cleanup rule and
never promote an incomplete block.

If old-block deletion fails, the candidate is rolled back and no promotion
occurs. If deletion has an ambiguous outcome, an idempotent retrieve/delete
check establishes the remote state before promotion. A complete candidate
record allows a later run to promote it only when the old block is confirmed
gone; otherwise it is cleaned up. Syntactically or structurally corrupt recovery
metadata produces a redacted warning and stops note synchronization before any
Notion mutation, because an unknown active mapping cannot be replaced safely.

## Idempotency and concurrency

The note hash covers the title, Zotero's serialized note HTML, and the ordered
sequence of attachment keys and image content hashes. The mapping namespace and
locks additionally scope the source by Zotero library ID, parent item key, and
note item key. An unchanged active record with the same target and source hash
exits before candidate creation or upload only after bounded retrieval confirms
that the mapped block still exists.

For a text-only change, resolved images are matched by target identity,
attachment key, and content hash. Their previously attached File Upload IDs
are reused. Add, delete, replace, and reorder operations produce a new ordered
candidate and a cache containing only images present in the successful source
version.

`withNoteSyncLock()` in `src/content/sync/note-sync-lock.ts` first serializes by
`libraryID + parent item key`, protecting the shared link-attachment metadata,
and then by `libraryID + note item key`. The note HTML and metadata snapshot are
read only after both locks are acquired. A queued overlapping synchronization
therefore observes the latest Zotero source and either commits it or exits
unchanged; it cannot create a simultaneous candidate or duplicate upload.

## Metadata compatibility

`getSyncedNotesFromAttachment()` continues to load both legacy
`noteBlockIDs` and current `notes.{key}.{blockID,syncedAt}` records. New fields
are optional and validated independently:

- `sourceHash`;
- `target`;
- `images` (attachment key, hash, upload ID, MIME, size);
- `candidate` (complete candidate recovery only);
- `orphanBlockIDs`.

Malformed JSON and invalid known fields return `metadataCorrupt` instead of
throwing from `JSON.parse()`. The coordinator reports the problem and refuses
to overwrite the unknown state. Saving uses the same hidden
`notero-synced-notes` element and remains backward compatible. Page target
changes already clear note metadata in `saveNotionLinkAttachment()`.

## Error isolation and logging

`syncItems()` catches `ItemSyncError` per item, reports it in the progress UI,
and continues unrelated items. The final job state records that failures
occurred without aborting the remaining queue.

The Notion client uses WARN logging, and its adapter logs only the SDK message
and safe status metadata. It never forwards response bodies or request
payloads. Image errors redact absolute paths. Logs do not include note HTML,
binary/base64 data, tokens, or complete private note text.

## Automated test matrix

- Parser: standard `IMG`, `data-attachment-key`, PDF `data-annotation`, pasted
  images, malformed/unsupported images, images between text, nested images,
  multiple images, and unchanged text fixtures.
- Resolver: personal/group library identity, parent/type/deleted validation,
  missing/unreadable files, PNG/JPEG and every allowed signature, MIME
  mismatch, corruption, size boundaries, and stable/changed SHA-256.
- Upload service: create/send/status, image attachment request, target-scoped
  cache, disabled behavior, 401/403/409/429/529/5xx/timeout, expiry, and bounded
  retry counts.
- Coordinator: first sync, unchanged sync, text-only/image changes, all
  ordering cases, multi-batch append, failures at every stage, old-delete and
  cleanup failure, recovery metadata, stale/missing blocks, manual moves, and
  preservation of unrelated content.
- Concurrency: overlapping automatic/manual work for one note and independent
  notes; exactly one candidate at a time and latest-source convergence.
- Compatibility: legacy metadata, corrupt metadata, default-off preference,
  identical text-only conversion, and continuation after one item failure.

## Manual end-to-end validation

Use a new Zotero development profile, a synthetic test library, a separate
Notion test database, and a test-only connection. Validate first sync,
unchanged sync, text-only edit, image add/delete/replace/reorder, preference
off/on, multi-image ordering, authorization failure, network interruption,
rate limiting (mocked if necessary), unrelated Notion content, unchanged
Zotero source data, and redacted logs. Record every result. No manual result is
considered passed until it is executed in that isolated environment.

## Source/API references

- `src/content/services/event-manager.ts`: `EventManager.notify()`
- `src/content/services/sync-manager.ts`: `SyncManager.handleNotifierEvent()`,
  `SyncManager.performSync()`
- `src/content/sync/sync-job.ts`: `performSyncJob()`, `prepareSyncJob()`,
  `syncItems()`
- `src/content/sync/sync-note-item.ts`: `syncNoteItem()`,
  `appendNoteBlockContent()`, `buildBlockBatches()`
- `src/content/sync/html-to-notion/parse-node.ts`: `ParsedNode`, `parseNode()`
- `src/content/sync/html-to-notion/html-to-notion.ts`:
  `convertHtmlToBlocks()`
- `src/content/data/item-data.ts`: `SyncedNotes`,
  `getSyncedNotesFromAttachment()`, `saveSyncedNoteRecord()`
- `src/content/sync/notion-client.ts`: `getNotionClient()`
- `node_modules/@notionhq/client/build/src/Client.d.ts`: SDK
  `fileUploads` methods
- [Notion File Upload](https://developers.notion.com/reference/file-upload),
  [Create](https://developers.notion.com/reference/create-file),
  [Send](https://developers.notion.com/reference/upload-file), and
  [Block](https://developers.notion.com/reference/block) API documentation
- Zotero 10 note editor and attachment APIs: `data-attachment-key`,
  `Zotero.Items.getByLibraryAndKey()`, `isEmbeddedImageAttachment()`, and
  `getFilePathAsync()`
