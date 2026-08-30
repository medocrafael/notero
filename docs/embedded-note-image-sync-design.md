# Embedded Zotero Note Image Synchronization

## Scope and safety boundary

This design synchronizes standard images embedded in Zotero 10 child notes to
Notion. It reads note HTML and embedded-image attachments through supported
Zotero APIs, validates local bytes, and sends them directly to Notion's official
File Upload API. It never reads Zotero SQLite, constructs storage paths, exposes
local files over a public URL, or modifies Zotero source data.

`NoteroPref.syncNoteImages` is opt-in and defaults to `false`. When disabled,
`NoteSourceAdapter.create()` does not call `findEmbeddedImages()` or
`resolveNoteImage()`, produces the `text-only-v1` policy, and the v3 validator
forbids upload records and upload intents.

The Notion documentation explicitly supports upload-once/attach-many reuse,
including reuse after the original block is deleted:

- <https://developers.notion.com/guides/data-apis/uploading-small-files>
- <https://developers.notion.com/reference/file-upload>
- <https://developers.notion.com/reference/block>

No undocumented idempotency key is used.

## Production call path

The automatic path remains:

```text
EventManager.notify()
  -> SyncManager.handleNotifierEvent()
  -> SyncManager.performSync()
  -> performSyncJob()
  -> syncItems()
  -> syncNoteItem()
```

`src/content/sync/sync-note-item.ts` is now a thin boundary. It:

1. rejects top-level notes and unsynchronized parents;
2. acquires the parent and note locks through `withNoteSyncLock()`;
3. constructs the exact `TargetIdentity`;
4. freezes a `NoteSourceAdapter` snapshot;
5. loads/migrates metadata through `ZoteroMetadataStoreAdapter`;
6. runs `NoteSyncTransactionExecutor` with `NoteTransactionCoordinator` and
   `NotionOperationAdapter`;
7. maps quarantine or unresolved uncertainty to a localizable error.

It contains no transaction stage switch, remote recovery branch, promotion
branch, upload journal hooks, or orphan cleanup loop.

## Invariants I1-I12

`validateTransactionInvariants()` and reducer/model tests enforce:

1. **I1 — Last-known-good preservation.** `active` is unchanged until a fully
   finalized candidate is locally committed.
2. **I2 — Exact ownership.** A mutation target requires block ID, parent,
   creator, ownership marker, version marker, and stored evidence.
3. **I3 — No guessing from absence.** Notion 404, zero matches before an
   isolation deadline, incomplete pagination, and multiple matches never prove
   success.
4. **I4 — Durable intent first.** Every remote mutation is emitted by the
   reducer and persisted as an `operationIntent` before execution.
5. **I5 — State/evidence recovery.** Restart observes the persisted operation;
   it does not dispatch to ad-hoc recovery functions.
6. **I6 — Version separation.** `requestedSourceVersion`, transaction
   `sourceVersion`, candidate version, and active version have distinct roles.
7. **I7 — Idempotency.** Unchanged active source/policy produces no metadata
   write or remote mutation. Operation IDs and exact observations prevent
   blind replay.
8. **I8 — Monotonic commit.** Only `CANDIDATE_DURABLE` can become active.
9. **I9 — Feature-off safety.** `text-only-v1` has no image discovery, local
   byte read, File Upload operation, or upload metadata.
10. **I10 — Unknown evidence is preserved.** Invalid native records and future
    schemas are quarantined/read-only, never normalized into mutation authority.
11. **I11 — One authoritative active.** `active` is a single local pointer;
    retired blocks exist only in the cleanup ledger.
12. **I12 — Intent/evidence coupling.** Observation operation ID and request
    digest must match the durable intent and transaction identity.

## Nine-state machine

The closed state enum is declared in
`src/content/sync/note-sync-transaction/types.ts`:

```text
IDLE
  -> PREPARING
  -> CANDIDATE_CREATING
  -> CANDIDATE_WRITING
  -> CANDIDATE_VERIFYING
  -> CANDIDATE_DURABLE
  -> ACTIVE_COMMITTED
  -> CLEANING
  -> IDLE

any invalid or unknowable safety condition -> QUARANTINED
```

`operationIntent.phase` is the separate closed enum `INTENDED | UNCERTAIN`.
There is no free-form `stage` field.

`CANDIDATE_DURABLE` already has the final title, final content, stable note
ownership marker, stable version marker, and exact finalization evidence.
`COMMIT_ACTIVE` is local-only: it atomically changes `active`, moves the old
active into the cleanup ledger, and enters `ACTIVE_COMMITTED`. No remote
promotion is permitted or required.

## Reducer and executor protocol

`transition()` in `reducer.ts` is pure. It has no clock, randomness,
persistence, Zotero, file-system, or Notion dependency. A remote mutation uses
one mandatory protocol:

```text
coordinator event
  -> pure reducer effect with complete operation identity
  -> CAS-persist INTENDED operationIntent
  -> execute remote operation
  -> classify exact remote observation
  -> reducer observation event
  -> CAS-persist next state
```

If the process stops after the remote result but before the second persist, the
same durable intent remains. Restart calls `observe()`. It does not blindly
re-execute create/append/send operations.

`APPEND_BATCH` uncertainty abandons the entire candidate because Notion does
not provide a documented append idempotency key. Confirmed attached uploads are
retained; the batch is never replayed into the same candidate.

## Persisted schema v3

The hidden Notero link-attachment metadata root is:

```text
schemaVersion: 3
container: exact ManagedResourceRecord | null
containerTarget: exact connection/workspace/database/page/library/parent scope
notes[noteItemKey]: NoteSyncRecordV3
legacy: immutable formal-main IDs, when present
preservedUnknown: unknown root evidence, when present
```

`NoteSyncRecordV3` stores the nine-state value, one active version, optional
candidate, cleanup ledger, bounded uploads, bounded quarantine records,
transaction/source generations, exact target identity, optional operation
intent, and `recordRevision`.

The three validation layers in `schema.ts` are:

1. JSON syntax;
2. strict Zod field shape;
3. cross-field transaction invariants.

Invalid JSON, fields, target scope, transaction relationships, or future
schema evidence authorizes no remote action. Raw metadata remains in the Zotero
link attachment for diagnosis.

## recordRevision and stale writers

Both metadata adapters implement optimistic compare-and-swap:

1. load revision `N`;
2. reject persist unless the current record and proposed record are both `N`;
3. write revision `N + 1`;
4. reload and confirm revision, state, and transaction identity;
5. on `StaleRecordRevisionError`, reload, validate, and select a new
   transition.

The production adapter runs under the existing parent and note locks. The
revision is still authoritative rather than decorative; stale executor tests
prove that the second writer cannot overwrite the first.

## Remote operation identity

Every create, append, finalization, delete, upload create, and upload send
intent includes:

```text
transactionID
operationID
note generation
operation generation
sourceVersion
exact TargetIdentity
requestDigest
operation-specific exact evidence
```

Create reconciliation exhausts bounded pagination and accepts exactly one
creator/parent/marker/version match. Zero before the persisted isolation
deadline and multiple matches remain uncertain. A final zero match after the
deadline is proven-unexecuted.

Upload create uses a deterministic target/source/content-derived filename and
bounded list reconciliation. Upload send observes a pending upload before the
first send. After `UPLOAD_SEND` is durable, restart is retrieve-only and never
resends bytes.

## Unified DELETE_INTENT protocol

The same `DELETE_BLOCK` intent handles retired active, aborted candidate,
superseded candidate, orphan cleanup, and unused-container cleanup. It stores:

```text
transactionID / operationID / generations / sourceVersion / target
exact block ID
expected parent
expected creator
expected ownership marker
expected version marker
expected lastEditedTime
request digest
reason
```

The adapter retrieves before delete. Exact live unchanged evidence may be
deleted under the same persisted intent. Exact `in_trash=true` evidence proves
a previous same-intent delete. A 404 never proves deletion. A moved, edited,
re-created, differently marked, differently versioned, or differently created
block is quarantined and not mutated.

## Source and image model

`NoteSourceAdapter.create()` freezes the note HTML/title, feature policy,
ordered embedded-image descriptors, image content hashes, deterministic block
template, content manifest, and source version before the transaction begins.
Local image bytes are released after preflight and re-resolved only for the
single intended upload send; the hash, MIME type, and size must still match.

The source version domain includes:

```text
library + parent item + note item
title + note HTML
feature policy
ordered attachment identity + content hash + alt text
converter version
```

The parser represents `IMG` explicitly. Inline image boundaries normalize to
Notion block order (`text -> image -> text`) without silently dropping images.
Supported bytes remain PNG, JPEG, GIF, and WebP under the existing direct
upload size and per-note count/aggregate limits.

Official Notion documentation states that an attached upload has null
`expiry_time`, becomes persistent, and its ID remains reusable across blocks or
pages even if original content is deleted. The cache therefore reuses only an
exact target plus attachment-key plus content-hash match whose status is
attached, or an uploaded/unexpired object still eligible for attachment.

## Source change behavior

- Before durability: abandon the candidate; preserve active; clean only exact
  managed candidate evidence.
- At durability with an existing active: abandon the candidate and keep the
  old active.
- At durability without an active: commit the durable candidate first as the
  LKG, then schedule the newer source.
- After active commit: never roll active back; finish exact cleanup and start a
  later generation.
- Feature policy changes participate in source versioning. OFF never reads
  image metadata.

## Legacy compatibility

Formal-main `containerBlockID`, `noteBlockIDs`, and
`notes[noteKey].blockID/syncedAt` are preserved only as immutable legacy
evidence. They are not adopted, updated, or deleted. The first v3 sync creates
a new managed container and note copy and adds a migration notice.

Unpublished feature-v2 transaction metadata is not recovered. Its free-form
stages are quarantined with no remote mutation. This avoids an old/new dual
runtime.

## Bounded failure behavior

The existing File Upload service bounds HTTP 409/429/5xx retry attempts and
total delay; 429 honors `Retry-After`. Authentication/authorization failures
are not retried. Create/list, append, finalization, delete, upload create, and
upload send observations all have bounded pagination or one-step recovery.

Quarantine and cleanup/upload ledgers are bounded. The executor has a maximum
transition count. There is no automatic infinite retry loop.

## Test architecture

- `reducer.spec.ts`: table-driven T1-T23 transitions and illegal events.
- `model.spec.ts`: deterministic state/event/failpoint/restart BFS to depth 12
  and properties P1-P10.
- `schema.spec.ts`: three-layer validation and invariant rejection.
- `executor.spec.ts`: intent-before-remote ordering, crashes, uncertainty,
  restart, JSON identity, and stale writers.
- `notion-operation-adapter.spec.ts`: exact create/delete/finalization,
  404/ownership/pagination ambiguity, append non-replay, and upload-send
  retrieve-only behavior.
- `coordinator-integration.spec.ts`: stateful convergence, unchanged idempotency,
  safe replacement, and H-01.
- `sync-note-item-stateful.spec.ts`: native production wiring, 101-block
  batching, Feature OFF, upload reuse, legacy migration, multiple notes, and
  cross-target isolation.
- Existing parser/resolver/upload/ownership tests retain text/image regression
  coverage with synthetic fixtures.

No test accesses a production Zotero profile or Notion workspace.
