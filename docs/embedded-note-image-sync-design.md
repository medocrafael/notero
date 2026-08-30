# Embedded Zotero Note Image Synchronization — FSM v2 Design

## Scope and release gate

This design synchronizes images already embedded in Zotero child notes. It does
not synchronize arbitrary PDF attachments, ZIP archives, Markdown folders, or
external media. Local bytes travel directly from Zotero to the official Notion
File Upload API. No public URL, relay, tunnel, or third-party image host is used.

The feature remains opt-in through `NoteroPref.syncNoteImages`, whose default is
`false`. With the preference off, `NoteSourceAdapter.create()` does not inspect
or resolve embedded images and emits the `text-only-v1` policy. Schema invariant
V13 rejects image upload work under that policy.

This branch is an implementation candidate for independent read-only review.
It is not approved for release or installation. No XPI is produced by this
workstream and no production Zotero profile or Notion workspace is used.

## Runtime compatibility

The production FSM, schema, reducer, executor, cleanup ledger, and upload model
are shared by Zotero 9.x and Zotero 10.x. Runtime differences are confined to
`ZoteroRuntimeAdapter` in
`src/content/sync/note-sync-transaction/zotero-runtime-adapter.ts`.

The adapter capability contract requires `Zotero.DB.executeTransaction`,
`Zotero.DB.inTransaction`, item get/reload, note get/set, `Item.save`, linked-URL
attachments, and the main-window Web APIs used by note and image processing.
Metadata writes use `attachment.save()` through `saveItem()` inside
`executeTransaction()`; `saveTx()` and direct SQLite access are not used.

Runtime validation status:

- Zotero 9.0.6: the isolated transaction spike passed fresh reload, revision
  comparison, immutable root merge, `setNote()`, `save()`, durable reload,
  stale-writer rejection, and serialized concurrent transactions.
- Zotero 10.x: code-compatible target; runtime validation is still pending.

The unified add-on compatibility range is Zotero 9.0 through 10.0.\*.

## Production call path

The event path remains:

```text
EventManager.notify()
  -> SyncManager.handleNotifierEvent()
  -> SyncManager.performSync()
  -> performSyncJob()
  -> syncItems()
  -> syncNoteItem()
```

`src/content/sync/sync-note-item.ts` is a wiring boundary. It acquires the
existing parent/note lock, validates the target identity, freezes a
`NoteSourceAdapter`, constructs the v4 metadata store, coordinator, upload
service, operation adapter, and executor, maps terminal failures to localizable
errors, and opportunistically runs a bounded cleanup worker. Transaction logic
does not live in this entry point.

## Authoritative data flow

```text
frozen source snapshot
  -> MainCoordinatorV2 selects a registered production event
  -> transitionMainV2 applies the pure registered reducer
  -> ZoteroTransactionalMetadataStoreV4 atomically persists exact state
  -> authorization reloads and validates the durable intent and lease
  -> NotionOperationAdapterV2 immediately revalidates remote ownership
  -> one authorized remote operation or read-only observation
  -> exact RemoteObservation
  -> registered reducer transition
  -> atomic v4 metadata persist
```

The production transition registry in `transition-registry.ts` is the only
main-state transition table. Coordinator output, executor observations, tests,
and the model explorer all use `TRANSITION_REGISTRY`; there is no test-owned
event set.

## Seven-state main FSM

`MAIN_STATES_V2` in `types-v4.ts` is exactly:

```text
IDLE
PREPARING
CANDIDATE_CREATING
CANDIDATE_WRITING
CANDIDATE_VERIFYING
CANDIDATE_DURABLE
QUARANTINED
```

The normal path is:

```text
IDLE
  -> PREPARING
  -> CANDIDATE_CREATING
  -> CANDIDATE_WRITING
  -> CANDIDATE_VERIFYING
  -> CANDIDATE_DURABLE
  -> atomic local commit
  -> IDLE
```

`active` is a durable fact, not a process state. The candidate is created with
its final visible title and stable operation, ownership, and source markers.
All child blocks are appended and then read-only verified before durability.
There is no remote finalization update and the v4 Notion client type does not
expose `blocks.update`.

`M16_COMMIT_DURABLE_CANDIDATE` is local-only. In one Zotero metadata
transaction it installs the durable candidate as `active`, appends the previous
active to cleanup as `PENDING`, clears `mainTransaction`, returns to `IDLE`, and
keeps the newest `requestedSource`. No Notion mutation occurs during commit.

## Source latest-wins protocol

The schema separates:

```text
record.requestedSource.sourceVersion
record.mainTransaction.transactionSourceVersion
record.active.sourceVersion
```

`SOURCE_OBSERVED` is emitted only when source version, manifest, or feature
policy differs from the durable requested source. Once persisted, the same
snapshot cannot emit it again.

If a newer source arrives during a non-durable transaction, an executable
intent is first observed, rejected, or sealed. With no blocking intent,
`M17_SUPERSEDE_TRANSACTION` moves any exact candidate to cleanup and starts the
newest generation without waiting for cleanup. A first durable candidate is
committed as the LKG before a newer source is consumed; when an older active
already exists, a superseded durable candidate goes to cleanup and the existing
active remains authoritative.

## Schema v4 and central validation

`SyncedNotesRootV4` contains:

```text
schemaVersion: 4
rootRevision
container: ManagedContainerMapping | null
notes[noteItemKey]: NoteSyncRecordV4
legacy?: immutable formal-main evidence
preservedLegacyFields?: unknown formal-main fields
```

Each note record contains exact target identity, requested source, active
mapping, main state and transaction, independent cleanup ledger, upload assets,
sealed quarantine evidence, remote liveness evidence, writer lease, and note
revision.

`validateTransactionRecord()` in `schema-v4.ts` implements V1–V18 and is called
on load, before persist, before mutation authorization, before active commit,
before cleanup delete, and before accepting observations. The invariants bind:

1. schema/target and all derived target digests;
2. main state to exactly one matching transaction where required;
3. transaction ID, generation, source, and feature policy;
4. operation kind, sequence, request digest, lease, target, and transaction;
5. operation details to the exact current container/candidate/upload/cleanup;
6. candidate identity and ownership to its transaction;
7. candidate status to the current main state;
8. contiguous unique batch evidence and returned block identities;
9. complete verification evidence to the exact candidate and manifest;
10. active to deterministic durable-candidate evidence;
11. active exclusion and unique cleanup ownership;
12. cleanup resource, ownership, intent, lease, and observation;
13. upload content identity, lifecycle, expiry, target, and Feature OFF;
14. requested/transaction/active latest-wins consistency;
15. permanently sealed quarantine evidence;
16. current executable intent authorization;
17. liveness evidence to the exact mappings and target;
18. root/note revision monotonicity and exactly-one increments.

An observation that violates an invariant cannot authorize mutation or commit.
The executor emits production transition `M21_VALIDATION_QUARANTINED`, retains
sealed intent/evidence, preserves the active LKG, and fails closed.

## Atomic Zotero metadata store

`ZoteroTransactionalMetadataStoreV4.writeAtomically()` performs:

```text
Zotero.DB.executeTransaction(async () => {
  fresh reload of the linked-URL metadata attachment
  parse and validate schema v4
  compare rootRevision and note revision
  immutable per-note mutation/merge
  validate proposed record
  increment rootRevision and note revision exactly once
  serialize and enforce metadata budget
  attachment.setNote(...)
  await attachment.save({ skipNotifier: true })
})
```

This is an atomic local compare–merge–write protected by the Zotero database
transaction. It is not described as CAS. `StaleRootRevisionError` and
`StaleRecordRevisionError` cause a fresh load; a stale writer cannot overwrite
another note/main/cleanup update.

## Writer lease and persist-before-remote

Every main operation has a process session, transaction ID, generation,
operation sequence, lease ID/epoch, source version, target digest, request
digest, and exact operation details. Cleanup owns a separate delete intent and
worker lease per ledger entry.

`MainTransactionExecutorV2` first persists the exact executable intent. It then
reloads the store, calls `authorizeMainMutation()`, validates the unexpired
lease and exact durable intent, consumes a one-time authorization token, and
allows at most one execution attempt for that operation ID in the invocation.
Restart with a durable intent calls `observe()` rather than blind replay.

The executor has bounded run steps and mutation attempts. Exhausting the local
mutation budget persists `TRANSIENT_BUDGET_EXHAUSTED` without remote I/O.

## Remote ownership and Notion TOCTOU

Before append, upload send, or delete, `NotionOperationAdapterV2` retrieves the
exact remote resource and validates full-block shape, ID, creator, parent,
stable operation/ownership/version markers, target scope, expected title where
applicable, trash state, and last-edited evidence where required. Incomplete
pagination and partial blocks fail closed.

Notion API version `2022-06-28` has no documented conditional block mutation,
ETag, or remote compare-and-swap. A read followed by a mutation therefore has
an unavoidable TOCTOU interval. The design minimizes it through an immediate
pre-write read and post-write observation but does not claim remote atomicity.

## Cleanup ledger FSM

Cleanup is orthogonal to the main FSM. Each target independently uses:

```text
PENDING
DELETE_INTENDED
DELETE_UNCERTAIN
QUARANTINED
CONFIRMED
```

`transitionCleanupV4()` may change only cleanup-owned fields and linked sealed
evidence. It is prohibited from changing `mainState`, `mainTransaction`,
`active`, or `requestedSource`. The main selector never gates progress on
cleanup count, state, lease, or retry deadline.

`CleanupWorkerV2` selects at most two due targets by default, excludes the
current active block, persists a target-specific lease and exact delete intent,
reloads and authorizes immediately before delete, and classifies the result.
Each entry has three bounded remote attempts and exponential retry deadlines.
Cleanup errors are captured and do not change the authoritative main result.

Deletion is confirmed only by the exact block ID with consistent
`in_trash=true` and `archived=true` evidence under the fixed API version. A
404, absent block, archived-only response, inconsistent trash fields, moved
block, edited block, creator/marker/parent mismatch, permission error, or
incomplete observation is uncertain or quarantined—never success.

## Permanent errors and quarantine

HTTP 400/401/403 and other proven permanent errors create one `RunHalt` and
sealed evidence. The same executor invocation stops after at most one mutation
attempt; it cannot immediately re-plan the rejected operation. A later user
invocation may emit `M05_RESUME_AFTER_HALT`, clear the local halt, acquire a new
lease/session, and continue after the external condition is repaired.

Unknown post-write outcomes enter `QUARANTINED` with the original operation
intent sealed, the last observation, source/transaction/generation/target
identity, resource expectation, reason, and repair category. Sealed intents
cannot become executable again.

## IDLE liveness

An IDLE active/container mapping is not trusted forever. If no exact liveness
evidence exists, its TTL expires, or forced validation is requested,
`M03_START_LIVENESS` and `M22_LIVENESS_INTENT_PERSISTED` record a read-only
verification intent. Exact evidence returns through `M23_LIVENESS_EXACT`.
Missing/moved/edited/trashed/mismatched evidence uses
`M24_LIVENESS_REPAIR_REQUIRED`, preserves the old local mapping as evidence,
and starts a fresh managed candidate without mutating the unverified resource.

The process-local `forceLiveness` token is consumed by the first liveness
intent. It cannot repeatedly re-enter liveness after `M23` in the same run.

## Image source and upload lifecycle

`NoteSourceAdapter` freezes the note title/HTML, ordered block batches,
feature policy, source/manifest digests, image occurrences, and canonical image
asset identities. Upload bytes are re-resolved only for the persisted send
intent and must still match hash, MIME, and size.

Supported image bytes are PNG, JPEG, GIF, and WebP. SVG, APNG, AVIF, and BMP
fail safely. Limits are 32 occurrences per note, 100 MiB aggregate source bytes,
20 MiB per single-part upload, and upload concurrency one.

The lifecycle is:

```text
pending
  -> uploaded-unattached (expiring)
  -> attached-persistent (expiry_time = null)
```

Only exact target/content/attachment identity is reusable. Attached upload IDs
remain reusable after the old candidate block is removed. Unchanged note sync
is skipped entirely, so it performs no upload, visible block duplication, or
mapping churn.

## Explicit Notion API version

`getNotionClient()` pins `notionVersion: "2022-06-28"`. The multipart upload
transport also adds `Notion-Version: 2022-06-28`. Transport tests cover both
ordinary JSON and multipart requests; the implementation does not rely on the
SDK default or upgrade the API version in this refactor.

## Legacy and unpublished metadata

Formal-main bare `containerBlockID`, `noteBlockIDs`, and note `blockID/syncedAt`
values are immutable legacy evidence. They never become ownership authority and
are never adopted, updated, archived, or deleted. Migration creates a new v4
managed container and note copy, preserves legacy remote content, stores the new
active mapping, and does not repeat the copy on unchanged sync.

Unpublished feature-v2/v3 transaction schemas are not recovered through old
stage logic. They fail closed with a development reset instruction. There is no
v1/v2 dual runtime and no `ACTIVE_COMMITTED` or `CLEANING` production state.

## Model and verification architecture

The deterministic bounded explorer uses the real coordinator, transition
registry, reducer, schema loader, executor, Notion operation adapter, upload
service, cleanup worker, and stateful fake server. Its canonical state contains
the full nested v4 root, exact remote block tree and markers, parent/child order,
trash fields, upload lifecycle, target, source, injected clock, permissions,
and crash category. Pruning occurs only for byte-identical canonical JSON.

A process restart serializes the root, discards process-local instances, keeps
the remote server, creates a new session/store/coordinator/payload adapter,
Notion adapter, and executor, reloads through `parseSyncedNotesRootV4()`, and
resumes only from durable intent and lease evidence. The explorer covers local
persist failure, remote commit with lost response, response-before-persist
crash, permission loss/restoration, move/edit/trash, clock jump, pagination
interruption, duplicate markers, target change, Feature ON/OFF, and cleanup
uncertainty.

Every P1–P15 property has a reducer/table test, a stateful integration test, and
an explorer assertion. Every production transition M01–M24 has a production-
reachable witness.

## Safety boundary after implementation

The implementation does not access production data, install a plugin, generate
an XPI, publish a release, modify an update manifest, merge the Draft PR, or
claim Zotero 10 runtime validation. The next gate is independent code review,
followed later by isolated Zotero 9/10 and Notion test-database validation under
separate authorization.
