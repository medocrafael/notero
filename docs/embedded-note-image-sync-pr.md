# Sync embedded Zotero note images through FSM v2

Closes the implementation scope for #385 without expanding into arbitrary
attachment/PDF synchronization from #772.

## Summary

This Draft PR synchronizes supported images already embedded in Zotero child
notes directly to Notion's official File Upload API while preserving text/image
order. The feature is explicitly opt-in and defaults off.

The transaction implementation is FSM v2 rather than a patch to the unpublished
FSM v1. It uses seven main states, an orthogonal cleanup ledger, schema v4,
atomic Zotero metadata transactions, durable operation intents and writer
leases, immediate remote ownership validation, IDLE liveness, sealed
quarantine evidence, and a production transition registry shared with tests.

FSM v2 implementation completed.
Zotero 9.0.6 transaction runtime validated.
Zotero 10 runtime validation pending.
Isolated RC pending independent security review.
No production Zotero/Notion data was accessed.

## Architecture

- `NoteSourceAdapter` freezes ordered text/image batches and stable source,
  manifest, attachment, content, and target identities.
- `TRANSITION_REGISTRY` M01–M27 is the only production main transition table.
- `validateTransactionRecord()` enforces V1–V18 at every trust boundary.
- `ZoteroTransactionalMetadataStoreV4` performs fresh reload, root/note
  revision compare, immutable merge, `setNote()`, and `attachment.save()` in
  `Zotero.DB.executeTransaction()`.
- `MainTransactionExecutorV2` persists exact intent before remote work,
  reloads/authorizes it, permits one operation attempt per ID/invocation, and
  transactionally reauthorizes exact root/note revision, intent, lease/session,
  and expiry after remote preflight and immediately before mutation.
- `NotionOperationAdapterV2` creates visibly incomplete staging candidates,
  seals and re-verifies their full child/upload manifest, persists a
  finalization intent, validates the container parent page, and immediately
  revalidates ownership before create, append, finalization, upload, and delete.
- `CleanupWorkerV2` processes at most two due entries by default and cannot
  change or block main state.
- `RuntimeClock` owns transaction, lease, retry, expiry, cleanup, evidence, and
  liveness time.

## Safety and idempotency

- The previous active note remains the LKG until the replacement has complete
  batch and final verification evidence and the local active commit succeeds.
- Active commit is one local metadata transaction after a separately persisted
  and remotely verified staging-title finalization.
- A 404, missing observation, incomplete pagination, archived-only response,
  moved/edited/trashed resource, or ownership mismatch never proves deletion.
- Cleanup uncertainty/quarantine remains durable but never gates a later source
  generation.
- Unchanged sync performs no remote mutation, upload, visible duplication, or
  mapping churn.
- Attached upload IDs are reused only for exact target/content identity, a
  recomputable asset-to-upload binding, and matching official remote
  creator/filename/MIME/length/lifecycle evidence; expired unattached IDs are
  replaced.
- Feature OFF performs no image discovery, byte read, upload, image block, or
  new image metadata work.
- Formal-main bare block IDs remain immutable evidence; new v4 managed copies
  are created without adopting, updating, or deleting legacy blocks.
- Unpublished feature-v2/v3 transaction metadata fails closed with development
  reset guidance; no FSM v1 runtime remains.

## Notion API contract

Both JSON and multipart transports explicitly send
`Notion-Version: 2022-06-28`. Supported direct-upload images are PNG, JPEG, GIF,
and WebP. SVG, APNG, AVIF, and BMP are rejected. Limits remain 20 MiB per
single-part upload, 32 image occurrences, 100 MiB aggregate bytes per note, and
upload concurrency one.

Notion does not expose a documented conditional block mutation/CAS at this API
version. Immediate read-before-write and post-write observation minimize but do
not eliminate the remote TOCTOU interval; this PR does not claim remote
atomicity.

## Tests

- The final-review red-phase checkpoint remains in history as `bb66069`.
- Every P1–P15 property has a production reducer/table test, a stateful Notion
  integration test, and a bounded model-explorer assertion.
- The model uses the production registry/coordinator/reducer/executor/adapters,
  complete nested canonical state, and genuine serialized process restart.
- Every registry transition M01–M27 has an automatic production-reachable
  witness; directed and synthetic coverage are both zero.
- Stateful failure paths cover persist failure, response loss, crash before
  observation persist, permission loss/restoration, moved/edited/trashed
  blocks, cleanup 404/archived-only evidence, clock jumps, pagination,
  duplicate markers, target change, and Feature ON/OFF.
- Existing parser, image resolver/validator, upload lifecycle, preference,
  localization, batching, legacy, multi-note, and target-isolation regression
  suites remain enabled.
- The final serial suite passes 38 files and 453 tests; the model explorer
  passes 17 tests with all M01–M27 and P1–P15 witnesses present.

Exact command results, test totals, source diagnostics, build status, and
GitHub Actions URL are recorded in
`docs/embedded-note-image-sync-test-report.md` for the final pushed SHA.

## Review boundary

Please keep this PR Draft. This change is ready only for independent read-only
code review after all exact-SHA checks pass. It is not ready for release,
production installation, or production-data E2E.

No XPI was generated or installed. No release or update manifest was created or
modified. Manual Zotero 9/10 plus separate Notion test-database E2E remains a
later explicitly authorized gate.
