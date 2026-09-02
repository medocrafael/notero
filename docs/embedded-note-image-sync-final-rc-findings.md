# Embedded Note Image Sync — Final Directed RC Findings

## Review basis

This remediation starts from
`805ad77e5e1257a882a88ca990a2723b5ed5c789` on
`feature/sync-embedded-note-images`. The independent directed review concluded
`NO-GO` for R-H01, R-H02, R-M01, R-M02, and R-L01. The tests-first evidence is
captured in `final-rc-red-results.md`.

No production Zotero profile, Zotero library, Notion workspace, token, paper,
note, or image is used by these tests. All remote behavior is mocked or handled
by the stateful synthetic Notion server.

## Finding-to-test matrix

| Finding | Required invariant                                                                                                                                          | Red test location                                    | Repair boundary                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| R-H01   | Every actual `fileUploads.create/send` attempt is immediately preceded by a fresh durable authorization for the exact intent, lease, revision, and attempt. | `upload-mutation-reauthorization-v4.spec.ts`         | Upload service attempt gateway plus the FSM remote adapter reauthorizer.                  |
| R-H02   | `root.container` is the sole canonical authority; ordinary note and cleanup writes cannot replace it.                                                       | `metadata-store-v4.spec.ts` multi-note cases         | Transactional metadata store with an explicit root-container delta.                       |
| R-M01   | Canonical pruning includes every field that can change a successor or its generated identity.                                                               | `model-canonicalization-v4.spec.ts`                  | Model harness, serialized model disk, fake remote projection, and explorer scheduler key. |
| R-M02   | The first isolated artifact is install-scoped only to the runtime-validation target; Zotero 10 remains a code contract until separately validated.          | `runtime-adapter-v4.spec.ts`                         | Generated-manifest source and compatibility documentation.                                |
| R-L01   | A known canonical container creator is relationally equal to candidate and upload operation `expectedCreator`, independent of recomputable request digests. | `metadata-store-v4.spec.ts` creator-corruption cases | Central schema-v4 cross-field validator and typed load quarantine.                        |

## Required post-repair gates

- Real upload service plus FSM adapter races, including 409/429 retry.
- Multi-note root repair, ordinary source write, cleanup, and stale-writer
  serialization.
- Creator corruption with a recomputed request digest and preserved
  last-known-good active evidence.
- Model successor-relevant canonical-state tests and depth-4 explorer metrics.
- Existing 22-case schema matrix, P1–P15, transition registry, stateful sync,
  full tests, production build, changed-file format/lint, diff check, repository
  verify where usable, and standalone typecheck status.

Packaging, XPI installation, push, PR mutation, Ready-for-review, merge, and
release remain outside this remediation round.

## Local remediation outcome

The directed checkpoint and local repair sequence is:

1. `63690e5` — tests-first reproduction and synthetic evidence;
2. `249af17` — per-attempt File Upload durable reauthorization;
3. `a125da1` — canonical root projection, V19 creator relation, and
   successor-complete model state;
4. `5cbca86` — Zotero 9-only initial compatibility gate and production smoke
   source;
5. `c688336` — discriminated root deltas, cleanup capability narrowing,
   per-SDK mutation audit, and final multi-note/adversarial coverage.

Post-repair local evidence is green for 40 test files and 476 tests, the
production build, 12 changed TypeScript files under type-aware Vite+ check,
and `git diff --check`. The depth-4 model explorer reports 276 canonical
states, 294 edges, 19 pruned states, 630 fresh-process restart checks, 27/27
automatic transition witnesses, and no counterexample. These bounded results
are regression evidence, not a formal proof.

Standalone `vp run typecheck` remains blocked by 13 pre-existing third-party
Vite+ declaration diagnostics under `node_modules`; no `skipLibCheck` was used.
Repository-wide verify reaches the known unrelated formatting baseline, while
every changed TypeScript/document file is checked separately.

## Runtime evidence and remaining gates

The Zotero 9.0.6 production adapter/store smoke was manually executed once and
passed against exact tested implementation SHA
`d5283d3161735de40f8feaede9fd8c1a5a1e6881`. Its bundle was 736,937 bytes;
`overall` was `PASS`, and all eight checks passed. The run created synthetic
parent/note/attachment IDs `3`/`4`/`5`, reported `notionConnected: false` and
`sqliteAccessed: false`, deleted the temporary bundle, and left the worktree
clean. This is distinct from the earlier primitive transaction spike.

The saved evidence is the Zotero result panel's complete structured object
representation. Strict `JSON.stringify` text was not separately saved before
the window closed. The smoke should not be rerun merely to obtain formatted
JSON, and this report does not fabricate an original JSON payload.

R-M02's Zotero 9 production-adapter gate is therefore satisfied for the tested
SHA. Zotero 10 runtime remains unverified, the separate Notion test-database
E2E has not run, GitHub Actions have not run for the new unpushed SHA, no XPI
has been generated, and the implementation is not release-ready. The branch
has not been pushed and no online PR was modified by this evidence update.
