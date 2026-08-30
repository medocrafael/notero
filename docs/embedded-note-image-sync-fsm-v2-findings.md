# FSM v2 Finding-to-Test Matrix

This matrix records the red-phase reproduction suite added at
`d6c7d844aeb710f7f1d11ee6c2692dddb134c867`. The tests use only synthetic
records, fake Notion responses, and in-memory metadata. They do not access a
Zotero profile or Notion workspace.

| Finding | Red test | Required passing behavior |
| --- | --- | --- |
| H-01 | `fsm-v2-findings.spec.ts` — consumes a changed source snapshot once | A persisted source observation is not re-emitted; no ACTIVE_COMMITTED/CLEANING livelock exists. |
| H-02 | `fsm-v2-findings.spec.ts` — keeps uncertain cleanup orthogonal | A newer main generation advances while the unresolved cleanup entry remains durable. |
| H-03 | `notion-operation-adapter.spec.ts` — validates ownership before finalization update | A moved candidate is retrieved and rejected before `blocks.update` can run. |
| H-04 | `fsm-v2-findings.spec.ts` — cross-field mismatch table | The central validator rejects mismatched operation, candidate, completion, active, cleanup, and upload identities. |
| H-05 | `fsm-v2-findings.spec.ts` — production Zotero store transaction contract | The production store uses `Zotero.DB.executeTransaction`, fresh attachment state, and `attachment.save()` in one transaction. |
| M-01 | `model.spec.ts` — nested canonical identity; `fsm-v2-findings.spec.ts` — production registry | Canonicalization retains nested safety identity and production owns the sole transition registry. |
| M-02 | `fsm-v2-findings.spec.ts` — permanent rejection run halt | A proven 400/401/403-style rejection stops the current run after one mutation attempt. |
| M-03 | `notion-operation-adapter.spec.ts` — archived-only delete response | Only exact `in_trash=true` evidence confirms deletion; `archived=true` alone fails closed. |
| M-04 | `fsm-v2-findings.spec.ts` — IDLE active liveness | An unverified or stale IDLE active schedules remote liveness validation. |
| M-05 | `fsm-v2-findings.spec.ts` — quarantine retains request digest | Sealed quarantine evidence preserves the complete original operation intent and observation. |
| L-01 | `fsm-v2-findings.spec.ts` — production clock scan | Transaction, upload, lease, retry, cleanup, liveness, and evidence time all flow through `RuntimeClock`. |

The focused red run is intentionally committed before production changes so a
reviewer can check out that commit and reproduce the failures independently.
