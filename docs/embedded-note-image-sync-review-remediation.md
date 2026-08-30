# FSM v2 Independent-Review Remediation Ledger

## Status

This document replaces the historical FSM v1 repair ledger. FSM v1 is no
longer a production or test runtime, so its old stages and recovery algorithms
must not be treated as current design guidance. The authoritative design is
`embedded-note-image-sync-design.md`; the red/final evidence mapping is
`embedded-note-image-sync-fsm-v2-findings.md`.

Current status is implementation complete pending full automated verification,
exact-SHA GitHub Actions, and independent read-only code review. No XPI has been
generated or installed and no production Zotero/Notion data has been accessed.

## Review findings and abstraction-level repairs

| Finding                           | Root cause                                                                                            | FSM v2 repair                                                                                                                                 | Primary evidence                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| H-01 source livelock              | Source change was represented by long-lived main states and repeatedly selected.                      | Persist `requestedSource` once; keep `active` as a fact; remove `ACTIVE_COMMITTED` and `CLEANING`; use latest-wins M01/M17/M16 transitions.   | `coordinator-v4.spec.ts`, P6, explorer             |
| H-02 cleanup blocks main          | Cleanup was part of the authoritative main state.                                                     | Independent cleanup ledger/reducer/worker; main selector has no cleanup guard; uncertainty remains per-entry.                                 | `cleanup-v4.spec.ts`, P11                          |
| H-03 unsafe finalization          | Candidate title/marker promotion used an ownership-sensitive remote update.                           | Create the candidate in final form and use read-only verification; v4 operation client has no update method.                                  | `notion-operation-adapter-v4.spec.ts`, P2/P13      |
| H-04 incomplete invariant binding | Individually valid fields could refer to different transactions/resources.                            | Central V1–V18 validator at load, persist, authorization, commit, delete, and observation acceptance.                                         | `invariants-v4.spec.ts`, `schema-v4.spec.ts`       |
| H-05 non-atomic revision check    | Old read/check/write logic was described as CAS without a DB transaction.                             | Fresh reload + root/note compare + merge + `attachment.save()` inside real `Zotero.DB.executeTransaction()`.                                  | `metadata-store-v4.spec.ts`, Zotero 9.0.6 spike    |
| M-01 weak model                   | Shallow canonicalization and test-owned events omitted safety identity and did not restart processes. | Full nested durable/remote canonical state, production registry/components, serialized root, new session and instances, retained fake server. | `model-harness-v4.ts`, `model-explorer-v4.spec.ts` |
| M-02 permanent-error replay       | Rejection immediately re-entered planning in the same run.                                            | Durable `RunHalt`; one attempt per operation/invocation; later invocation may emit M05.                                                       | `executor-v4.spec.ts`, P14                         |
| M-03 archived-only delete         | Deprecated alias was accepted without exact trash proof.                                              | Require exact block ID and consistent `in_trash=true`/`archived=true`; treat 404 and inconsistent fields as uncertain.                        | adapter tests, P3                                  |
| M-04 stale IDLE mappings          | IDLE skipped remote liveness.                                                                         | TTL/forced M03/M22/M23 and fail-closed M24 repair.                                                                                            | P15, explorer                                      |
| M-05 evidence loss                | Quarantine dropped the original executable request identity.                                          | Seal full original intent and last observation with transaction/generation/source/target/resource identity.                                   | P5, V15                                            |
| L-01 mixed clocks                 | Deadlines and retries used ambient time.                                                              | Inject `RuntimeClock` throughout transaction/upload paths; only the system clock adapter touches `Date`.                                      | clock scan, fake clock paths                       |
| V2-L01 forced-liveness loop       | A boolean force option remained true after exact liveness in the same coordinator.                    | Consume force as a one-shot process token when planning the first liveness intent.                                                            | executor force-liveness regression, model explorer |

## Adversarial checks

The final review must re-run these checks against the exact branch SHA:

- no cleanup state, retry deadline, or error gates main source progress;
- one observed source version is not emitted repeatedly;
- no same-run replay follows permanent validation/auth/permission rejection;
- every mutation audit has one exact durable executable intent and lease;
- append/upload-send/delete performs immediate remote ownership/status read;
- 404 and archived-only responses never confirm deletion;
- current active is excluded from executable cleanup;
- root and note revisions increment once in a Zotero DB transaction;
- stale main and cleanup writers merge from fresh root state;
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

Zotero 9.0.6 transaction runtime behavior has been validated in an isolated
development profile. Zotero 10 uses the same capability-based adapter and is a
code-compatible target, but its real runtime validation remains pending.

The implementation is not a release candidate until an independent reviewer
accepts the code and later isolated manual validation passes. No production
installation or production-data E2E is authorized by this ledger.
