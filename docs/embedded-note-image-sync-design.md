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

- Zotero 9.0.6 primitive transaction spike: previously supplied `PASS`. It is
  baseline evidence for receiver binding and transaction primitives, but it
  did not execute the current production runtime adapter and schema-v4 store.
- Zotero 9.0.6 production adapter/store smoke:
  `scripts/zotero-9-runtime-adapter-smoke.ts`; **PENDING USER RUN** in a
  disposable profile. This gate executes `ZoteroRuntimeAdapter` and
  `ZoteroTransactionalMetadataStoreV4`, including reload, `setNote()`/`save()`,
  exact revision reload, and stale-writer rejection.
- Zotero 10.x: static/type/mock code contract only; real runtime validation is
  pending and is not part of the first isolated RC.

The first isolated RC compatibility range is deliberately limited to Zotero
9.0 through 9.0.\*. The manifest may be broadened to Zotero 10 only after a
separate production-adapter runtime smoke and plugin E2E pass there.

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
  -> initial authorization reloads and validates the durable intent and lease
  -> NotionOperationAdapterV2 validates exact remote ownership/content
  -> read-only Zotero DB transaction reloads the durable authorization again
  -> exact root/note revision, intent, lease, and session must be unchanged
  -> one immediate authorized remote mutation or read-only observation
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
the visible staging title `Notero Sync Incomplete — <note title>` plus stable
operation, ownership, and source markers. All child blocks are appended and
read-only verified while that staging title remains visible. A separately
persisted `FINALIZE_CANDIDATE` intent then performs an ownership-sensitive
`blocks.update`, followed by an exact retrieve observation. Only a candidate
with complete append, verification, and finalization evidence may become
durable or enter `active`. A failed candidate is moved to cleanup evidence and
never retains the authoritative title in the active mapping.

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
13. upload content identity, recomputable File Upload binding, lifecycle,
    expiry, target, and Feature OFF;
14. requested/transaction/active latest-wins consistency;
15. permanently sealed quarantine evidence;
16. current executable intent authorization;
17. liveness evidence to the exact mappings and target;
18. root/note revision monotonicity and exactly-one increments.

The manifest is recomputed from a persisted canonical source descriptor rather
than trusted as duplicated digest strings. Each non-null File Upload ID also
has a domain-separated binding digest over the asset identity, target, and
upload ID. A swap that leaves copied binding evidence stale fails local
validation. A locally recomputed but wrong binding still fails closed because
append and candidate verification retrieve the exact official File Upload and
compare its creator, deterministic filename, MIME type, non-null content
length, status, archived state, and expiry against the frozen asset reference.
An observation that violates an invariant cannot authorize mutation or commit.
The executor emits production transition `M21_VALIDATION_QUARANTINED`, retains
sealed intent/evidence, preserves the active LKG, and fails closed.

Metadata load classifies `VALID`, `FUTURE_SCHEMA`, `PARSEABLE_INVALID`, and
`SYNTAX_INVALID`. Invalid raw metadata remains byte-for-text exact in the main
`pre`; before any Notion mutation, a Zotero DB transaction writes a safely
escaped, sealed, non-executable quarantine sidecar. If that sidecar save fails,
the original attachment note is restored in memory and a typed quarantine
error is returned.

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
reloads the store, calls `authorizeMainMutation()`, and allows at most one
execution attempt for that operation ID in the invocation. After the operation
adapter's remote preflight and immediately before its mutation, the executor
calls `loadForMutationAuthorization()`. The production store performs this
fresh reload and schema validation inside a read-only
`Zotero.DB.executeTransaction()`. A fresh one-time token is consumed only if
the root revision, note revision, exact canonical intent, lease/session, and
expiry still match the initial authorization. Restart with a durable intent
calls `observe()` rather than blind replay.

The executor has bounded run steps and mutation attempts. Exhausting the local
mutation budget persists `TRANSIENT_BUDGET_EXHAUSTED` without remote I/O.

## Remote ownership and Notion TOCTOU

Every ownership-sensitive mutation follows the same protocol: exact durable
intent and lease, remote read, ownership/content verification, transactional
durable reauthorization, immediate mutation with no intervening unrelated
await, then post-write observation. Container creation requires a full,
matching, untrashed parent page; candidate creation requires the exact managed
container. Append, upload send, and delete re-read their exact target and
identity/lifecycle evidence.

Finalization re-reads the candidate heading, fully paginates and hydrates its
children, compares ordered IDs and fingerprints against the sealed manifest,
and verifies every attached File Upload identity and lifecycle. The
finalization intent carries that complete verification descriptor, and schema
V5/V9/V10 bind it to the same completion evidence and active transaction.
Partial pages/blocks, incomplete pagination, edited children, stale upload
identity, or changed local authorization fail closed before `blocks.update()`.

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
sealed evidence. HTTP 409/429 creates a typed transient halt with a bounded
`nextRetryAt`; 429 honors a valid `Retry-After`. The same executor invocation
stops after at most one mutation attempt and cannot immediately re-plan the
rejected operation. A later invocation may first persist a newer source, then
emit `M05_RESUME_AFTER_HALT` only when due, acquire a new lease/session, and
continue. Candidate-create recovery uses registered transition M25 rather than
an external recovery branch.

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

pending/uploaded-unattached after deadline
  -> expired (archived = true; never attachable or reusable)
```

Only exact target/content/attachment identity is reusable. Attached upload IDs
remain reusable after the old candidate block is removed. Identity matching is
separate from lifecycle interpretation, so the official `expired` plus
`archived=true` representation is accepted as expiration rather than mistaken
for an ownership mismatch. On restart, an expired unattached upload is replaced
by a new operation generation and ID. Unchanged note sync is skipped entirely,
so it performs no upload, visible block duplication, or mapping churn.

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
an explorer assertion. Every production transition currently registered
(M01–M27, including M25–M27 added by this remediation) has an automatically
reached production witness; directed and synthetic witness counts remain zero.

## Safety boundary after implementation

The implementation does not access production data, install a plugin, generate
an XPI, publish a release, modify an update manifest, merge the Draft PR, or
claim Zotero 10 runtime validation. The next gate is the user-run production
adapter/store smoke in an isolated Zotero 9.0.6 profile. A PASS permits a later
push authorization request; it does not authorize XPI creation, installation,
Notion E2E, manifest broadening, or release.
