# FSM v2 Independent-Review Remediation Ledger

## Status

This document replaces the historical FSM v1 repair ledger. FSM v1 is no
longer a production or test runtime, so its old stages and recovery algorithms
must not be treated as current design guidance. The authoritative design is
`embedded-note-image-sync-design.md`; the red/final evidence mapping is
`embedded-note-image-sync-fsm-v2-findings.md`.

Current status is final directed remediation committed locally through
automated-remediation SHA `c688336`. The Zotero 9.0.6 production adapter/store
smoke passed once against exact tested implementation SHA
`d5283d3161735de40f8feaede9fd8c1a5a1e6881`. The branch is not pushed;
exact-SHA GitHub Actions have not run for the new local commit. No XPI has been
generated or installed and no production Zotero/Notion data has been accessed.

## Review findings and abstraction-level repairs

| Finding                            | Root cause                                                                                                                                          | FSM v2 repair                                                                                                                                                                                     | Primary evidence                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| H-01 source livelock               | Source change was represented by long-lived main states and repeatedly selected.                                                                    | Persist `requestedSource` once; keep `active` as a fact; remove `ACTIVE_COMMITTED` and `CLEANING`; use latest-wins M01/M17/M16 transitions.                                                       | `coordinator-v4.spec.ts`, P6, explorer                      |
| H-02 cleanup blocks main           | Cleanup was part of the authoritative main state.                                                                                                   | Independent cleanup ledger/reducer/worker; main selector has no cleanup guard; uncertainty remains per-entry.                                                                                     | `cleanup-v4.spec.ts`, P11                                   |
| H-03 unsafe finalization           | A candidate created with the final title could look authoritative before content completion.                                                        | Create with an explicit incomplete staging title; persist/authorize/update/observe finalization only after complete verification.                                                                 | adapter/executor/stateful finalization tests                |
| H-04 incomplete invariant binding  | Individually valid fields could refer to different transactions/resources.                                                                          | Central V1–V19 validator at load, persist, authorization, commit, delete, and observation acceptance.                                                                                             | `invariants-v4.spec.ts`, `schema-v4.spec.ts`                |
| H-05 non-atomic revision check     | Old read/check/write logic was described as CAS without a DB transaction.                                                                           | Fresh reload + root/note compare + merge + `attachment.save()` inside real `Zotero.DB.executeTransaction()`.                                                                                      | `metadata-store-v4.spec.ts`, Zotero 9.0.6 spike             |
| M-01 weak model                    | Shallow canonicalization and test-owned events omitted safety identity and did not restart processes.                                               | Full nested durable/remote canonical state, production registry/components, serialized root, new session and instances, retained fake server.                                                     | `model-harness-v4.ts`, `model-explorer-v4.spec.ts`          |
| M-02 permanent-error replay        | Rejection immediately re-entered planning in the same run.                                                                                          | Durable `RunHalt`; one attempt per operation/invocation; later invocation may emit M05.                                                                                                           | `executor-v4.spec.ts`, P14                                  |
| M-03 archived-only delete          | Deprecated alias was accepted without exact trash proof.                                                                                            | Require exact block ID and consistent `in_trash=true`/`archived=true`; treat 404 and inconsistent fields as uncertain.                                                                            | adapter tests, P3                                           |
| M-04 stale IDLE mappings           | IDLE skipped remote liveness.                                                                                                                       | TTL/forced M03/M22/M23 and fail-closed M24 repair.                                                                                                                                                | P15, explorer                                               |
| M-05 evidence loss                 | Quarantine dropped the original executable request identity.                                                                                        | Seal full original intent and last observation with transaction/generation/source/target/resource identity.                                                                                       | P5, V15                                                     |
| L-01 mixed clocks                  | Deadlines and retries used ambient time.                                                                                                            | Inject `RuntimeClock` throughout transaction/upload paths; only the system clock adapter touches `Date`.                                                                                          | clock scan, fake clock paths                                |
| V2-L01 forced-liveness loop        | A boolean force option remained true after exact liveness in the same coordinator.                                                                  | Consume force as a one-shot process token when planning the first liveness intent.                                                                                                                | executor force-liveness regression, model explorer          |
| H-07 stale local authorization     | The executor reloaded durable authorization before the adapter's remote preflight, leaving local revision/lease changes undetected before mutation. | Re-read and validate root/note revision, canonical intent, lease/session, and expiry in a read-only Zotero DB transaction after remote preflight and immediately before each mutation.            | `executor-v4.spec.ts`, `cleanup-v4.spec.ts`, adapter tests  |
| H-08 incomplete finalize preflight | Finalization re-read only the candidate heading before `blocks.update()`.                                                                           | Seal the verification descriptor into the finalization intent; re-page/hydrate all children, verify ordered fingerprints and attached uploads, then transactionally reauthorize.                  | finalization race/invariant/adapter tests                   |
| H-09 unchecked container parent    | Container creation appended under a page ID without canonical parent-page retrieval.                                                                | Require a full exact untrashed/unarchived page response before local reauthorization and append; partial or mismatched pages fail closed.                                                         | parent-page adapter tests                                   |
| R-H01 upload authorization gap     | Upload callbacks, polling, and retry sleep separated outer authorization from actual `fileUploads.create/send`.                                     | Move journal work before final authorization; reauthorize every exact indexed SDK attempt; do not await between returned authorization and SDK invocation; audit each real attempt.               | upload reauthorization tests, P4/P12                        |
| R-H02 duplicated root authority    | Projected per-note container copies could be written back over a fresher shared root.                                                               | Make `root.container` authoritative; ordinary writes preserve fresh root; use generation-checked `MAIN_CONTAINER_CREATED`/`LIVENESS_CONTAINER_CLEARED`; deny cleanup root capability.             | multi-note metadata-store matrix                            |
| R-M01 incomplete canonical key     | Identity/session/resource counters and control/failpoint state that change successors were omitted from pruning keys.                               | Retain every successor-relevant disk, identity, session, remote, clock, retry, failpoint, source-byte, and scheduler-control field without alpha normalization.                                   | canonicalization counterexamples, depth-4 explorer          |
| R-M02 unsupported runtime claim    | The manifest allowed Zotero 10 before current production-adapter runtime evidence existed.                                                          | Limit the first isolated scope to Zotero 9; retain Zotero 10 code contracts; record the 8 / 8 production adapter/store smoke PASS at exact tested SHA `d5283d3161735de40f8feaede9fd8c1a5a1e6881`. | runtime manifest test, smoke source and result-panel record |
| R-L01 creator relation gap         | Recomputable request digests did not prove that operation `expectedCreator` equaled the canonical remote creator.                                   | Add V19 relational validation for candidate/upload create/upload send while preserving the initial container-creator unknown exception.                                                           | creator corruption matrix                                   |

The later RC review findings C-01, H-01–H-06, and M-01–M-03 are mapped in
`embedded-note-image-sync-fsm-v2-findings.md`. Their repairs additionally
provide receiver-safe Zotero calls, distinct local/remote identity types,
visible candidate staging, total candidate-create progress, convergent cleanup,
official expired-upload lifecycle handling, recomputable source/upload proof
plus exact remote upload-identity observation, typed raw-preserving metadata
quarantine, registry-owned planning, pure reducers, and safe PRE/textContent
metadata encoding.

## Adversarial checks

The final review must re-run these checks against the exact branch SHA:

- no cleanup state, retry deadline, or error gates main source progress;
- one observed source version is not emitted repeatedly;
- no same-run replay follows permanent validation/auth/permission rejection;
- every actual SDK mutation attempt has one immediately preceding exact audit
  carrying its operation, attempt index, revisions, and lease;
- every mutation performs remote preflight, read-only transactional durable
  reauthorization, and then an immediate single write;
- finalization revalidates the complete child/upload manifest before update;
- container creation validates a full exact parent page before append;
- 404 and archived-only responses never confirm deletion;
- current active is excluded from executable cleanup;
- root and note revisions increment once in a Zotero DB transaction;
- stale main and cleanup writers merge from fresh root state;
- `root.container` changes only through the correct discriminated,
  generation-checked main/liveness delta; cleanup has no root mutation
  capability;
- all quarantine evidence retains a sealed original intent where one existed;
- every production registry transition has a real producer and witness;
- every restart creates a new session/store/coordinator/adapters/executor;
- transaction modules use `RuntimeClock`, not ambient time;
- Feature OFF performs no image resolution, upload, block, or metadata work;
- formal-main bare IDs remain immutable, non-authoritative evidence;
- no v1 module/state/recovery path is importable;
- cleanup/quarantine/upload metadata is bounded and compacted safely;
- Notion read-before-write is not described as conditional CAS.

## Remaining external limitations

Notion does not provide a documented conditional block update/delete primitive
for API version `2022-06-28`; an unavoidable TOCTOU interval remains between
the immediate ownership read and mutation. The implementation minimizes and
records that limitation but cannot claim remote atomicity.

The supplied isolated Zotero 9.0.6 primitive transaction spike remains
separate baseline evidence. The current production adapter/store smoke was
manually executed once at the exact tested SHA above. Its 736,937-byte bundle
returned `overall: PASS` with all 8 / 8 checks passing; synthetic
parent/note/attachment IDs were `3`/`4`/`5`, and `notionConnected` and
`sqliteAccessed` were both `false`. The temporary bundle was deleted and the
worktree returned clean.

The saved evidence is the Zotero result panel's complete structured object
representation. Strict `JSON.stringify` text was not separately saved before
the window closed. The smoke must not be rerun merely to obtain formatted JSON,
and this ledger does not fabricate original raw JSON.

The implementation is not release-ready. Zotero 10 real runtime validation
remains unverified and must not be inferred from capability-contract tests.
The separate Notion test-database E2E and GitHub Actions for the new local SHA
have not run, and no XPI has been generated. Push authorization, independent
review, and later isolated plugin/Notion validation remain separate gates. No
production installation or production-data E2E is authorized by this ledger.
