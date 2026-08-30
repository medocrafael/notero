# FSM v2 Finding-to-Test Matrix

The red-phase checkpoint is commit `9451c7b` (`test(sync): Reproduce FSM v2
review findings`). It follows the approved implementation starting point
`d6c7d844aeb710f7f1d11ee6c2692dddb134c867` and contains tests, fixtures, and
test infrastructure rather than the FSM v2 production repair. A reviewer can
check out that commit to reproduce the intended failures.

All evidence uses synthetic records, image fixtures, an in-memory metadata
store, or the stateful fake Notion server. It does not access a Zotero profile,
Notion workspace, token, database, paper, or private note.

| Finding | Red/final evidence                                                  | FSM v2 passing behavior                                                                                                           |
| ------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| H-01    | `fsm-v2-findings.spec.ts`, `coordinator-v4.spec.ts`, P6 model paths | A source snapshot is persisted once; the seven-state machine has no `ACTIVE_COMMITTED`/`CLEANING` livelock.                       |
| H-02    | `cleanup-v4.spec.ts`, P11 reducer/stateful/explorer tests           | `DELETE_UNCERTAIN` and cleanup quarantine never gate a newer source generation.                                                   |
| H-03    | `notion-operation-adapter-v4.spec.ts`, P2/P13                       | Candidate finalization is read-only; append/delete revalidate exact ownership immediately before mutation.                        |
| H-04    | `invariants-v4.spec.ts` V1–V18 table, `schema-v4.spec.ts`           | Cross-field operation, candidate, completion, active, cleanup, upload, target, source, and lease mismatches fail closed.          |
| H-05    | `metadata-store-v4.spec.ts`, `runtime-adapter-v4.spec.ts`           | The production store uses fresh reload + compare + immutable merge + `attachment.save()` inside `Zotero.DB.executeTransaction()`. |
| M-01    | `model-explorer-v4.spec.ts`                                         | The explorer retains the complete nested durable/remote state and uses only the production transition registry and components.    |
| M-02    | `executor-v4.spec.ts`, P14                                          | A permanent rejection creates one durable run halt and at most one mutation attempt in an invocation.                             |
| M-03    | `notion-operation-adapter-v4.spec.ts`, P3                           | 404, absent proof, and archived-only evidence are uncertain; only exact consistent trash evidence confirms deletion.              |
| M-04    | `coordinator-v4.spec.ts`, P15                                       | Missing/stale IDLE evidence schedules liveness, and mismatch enters the registered repair path.                                   |
| M-05    | `executor-v4.spec.ts`, P5                                           | Quarantine preserves the complete original intent and observation as sealed evidence.                                             |
| L-01    | `fsm-v2-findings.spec.ts` clock scan and clock-driven model actions | Transaction, upload, lease, retry, cleanup, liveness, and evidence time uses `RuntimeClock`.                                      |

The phase-6 model explorer found an additional production counterexample while
tests were still red: a static `forceLiveness` option repeatedly emitted
`M03 -> M22 -> M23` after exact verification until the step and mutation limits.
`MainCoordinatorV2` now treats forced liveness as a single-use process token,
consumed when the first liveness intent is planned. The executor regression
test requires one `M03` and one `M23` followed by `STABLE`.

Final property coverage is explicit: every P1–P15 property has one production
reducer/table test, one stateful integration test, and one bounded explorer
assertion. `model-explorer-v4.spec.ts` also requires a production-reachable
witness for every registry transition M01–M24 and reports the shortest action
sequence if any property fails.
