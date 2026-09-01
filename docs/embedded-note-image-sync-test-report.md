# Embedded Note Image Sync — Final Directed RC Remediation Test Report

## Status and evidence boundary

- Branch: `feature/sync-embedded-note-images`
- Directed-review start: `805ad77e5e1257a882a88ca990a2723b5ed5c789`
- Baseline `main`: `265c1711507d8f03305325cabe350543cfe1e4b1`
- Verified implementation SHA: `c688336`
- Node.js: `v24.19.0`
- Declared package manager: `pnpm@10.33.2`
- Vite+: `0.1.21`
- Notion SDK: `@notionhq/client` `4.0.1`
- Initial isolated compatibility scope: Zotero `9.0` through `9.0.*`

No production Zotero profile, library, item, paper, note, or image was read. No
production Notion workspace, database, page, or token was used. No SQLite
database, public relay, tunnel, or third-party image host was used. No XPI was
created or installed, and no release, update manifest, merge, PR mutation, or
push was performed.

Runtime evidence is deliberately separated:

- the previously supplied Zotero 9.0.6 primitive transaction spike is `PASS`,
  but it did not execute the current production adapter/store;
- the current `ZoteroRuntimeAdapter` plus
  `ZoteroTransactionalMetadataStoreV4` smoke is **PENDING USER RUN** in a
  disposable Zotero 9.0.6 profile;
- Zotero 10 remains code-targeted and mock/type tested, but real runtime
  validation is pending and is outside the first isolated RC scope.

## Tests-first evidence

Commit `63690e5` is the directed tests/fixtures/model-infrastructure checkpoint.
Before production repair, the focused run reported 17 failed and 38 passed
tests across four files, exit status 1. The behavioral failures were:

| Finding | Red evidence                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R-H01   | Create ran after `onCreateStarted` lease supersession; retry attempt 2 ran after an intent change; send ran after session replacement; gateway-level audit did not cover each SDK attempt. |
| R-H02   | A stale per-note C1 copy overrode or observed instead of canonical root C2; ordinary and cleanup writes could carry the stale copy.                                                        |
| R-M01   | Canonical keys merged states with different identity/session sequences, fake resource counters, failpoints, or scheduler-relevant control.                                                 |
| R-M02   | The generated manifest source still allowed Zotero 10 although no Zotero 10 runtime gate had passed.                                                                                       |
| R-L01   | Candidate/upload records remained schema-valid after `expectedCreator` corruption and recomputation of every non-secret request digest.                                                    |

The exact red summary is retained in
`src/content/sync/note-sync-transaction/__tests__/fixtures/final-rc-red-results.md`.
The required lowercase checkpoint subject was rejected by commitlint; the
normal-hook commit used repository-compliant sentence case. No hook was
bypassed.

The final adversarial pass added stronger tests before its refinement. That
focused run reported 4 failed and 73 passed tests, exit status 1: the old
single root-delta discriminator rejected the new main/liveness types, and the
model emitted 8 gateway-operation audits for only 6 real mutation attempts.
The send test initially exposed a synthetic polling-fixture error, which was
corrected without changing production behavior or weakening its assertion.

## Finding-to-repair evidence

### R-H01 — per-SDK-attempt durable reauthorization

`NotionImageUploadService` now calls an exact attempt authorizer after journal
callbacks and retry sleep. Each authorized create/send attempt immediately
invokes the SDK without another `await`. Every retry receives a monotonically
indexed attempt context. The production adapter consumes a fresh one-time
authorization only if root/note revision, exact executable intent, request
digest, transaction/generation/source/target identity, lease/session, expiry,
and run-halt state still match.

Create uncertainty still reconciles by bounded list/read and never blind
replays an unknown create. Send uncertainty restarts through retrieve only and
never resends bytes. Model mutation audits are now emitted for each actual SDK
mutation authorization rather than once per outer operation; they include
mutation name, attempt, operation ID/sequence, root/note revision, and lease
ID/epoch.

### R-H02 — canonical root container

`root.container` is the only write authority. Load projects it into the runtime
note view; ordinary main, note, and cleanup persistence must preserve the fresh
transaction-local root value. Root changes require one of two semantic delta
variants:

- `MAIN_CONTAINER_CREATED`: `null -> managed container`;
- `LIVENESS_CONTAINER_CLEARED`: `managed container -> null`.

The adapter validates the discriminator/endpoints and compares root revision,
note revision, expected old container, and monotonic `containerGeneration`
inside the Zotero DB transaction. `CleanupWorkerV2` receives a narrower store
interface with no root-delta method. Multi-note tests cover stale projection,
malicious ordinary writes, concurrent A repair/B persistence, fresh B candidate
parent C2, stale B liveness generation, and interleaved cleanup metadata.

### R-M01 — successor-complete canonicalization

The model key retains the full serialized schema-v4 root and every field that
can change a successor: identity sequence, process invocation count, fake
block/upload/page counters, upload lifecycles, failure controls, retry state,
permissions, clock/offset, source bytes, observation tamper state, disk
failpoints, and minimal scheduler eligibility. Opaque IDs are not alpha
normalized. Report-only history is excluded only when it cannot influence any
future action or successor.

The depth-4 deterministic bounded explorer reported:

| Metric                                |  Result |
| ------------------------------------- | ------: |
| Maximum depth                         |       4 |
| Canonical states                      |     276 |
| Explored edges                        |     294 |
| Canonically pruned states             |      19 |
| Fresh-process restart checks          |     630 |
| Automatic production transitions      | 27 / 27 |
| Directed/synthetic transition credit  |   0 / 0 |
| Missing transition witnesses          |       0 |
| P1–P15 with witnesses and no failures | 15 / 15 |
| Shortest counterexample               |    none |

This is bounded deterministic regression exploration, not a formal proof.

### R-M02 — runtime scope

The generated manifest source is limited to Zotero `9.0`–`9.0.*`. Production
capability architecture and Zotero 10 code-contract tests remain, but Zotero 10
runtime support is not claimed. `scripts/zotero-9-runtime-adapter-smoke.ts`
imports and invokes the actual runtime adapter and metadata store, including
load, transaction-local reload/compare/merge, `setNote()`/`save()`, stale-writer
rejection, and fresh-adapter reload. It was compiled during review but was not
executed, as required.

### R-L01 — creator relationship invariant

Schema invariant V19 requires candidate, upload-create, and upload-send
`expectedCreator` to equal the known canonical container remote creator.
Corruption tests change that field and recompute request digests; load still
fails closed before remote mutation and preserves raw evidence plus the
last-known-good active mapping. `CREATE_CONTAINER` retains the one permitted
`UNKNOWN_UNTIL_CREATED` acquisition case.

## Preserved FSM and regression properties

The seven-state main FSM, orthogonal cleanup ledger, latest-wins source model,
visible candidate staging, receiver-safe Zotero calls, local/remote identity
separation, sealed quarantine, exact trash proof, attached-upload reuse,
Feature OFF zero-image behavior, fixed Notion API version `2022-06-28`, safe
metadata text encoding, non-destructive legacy migration, and absence of a
feature-v2/v3 recovery runtime remain covered.

`properties-v4.spec.ts` retains reducer/table and stateful evidence for every
P1–P15 property. The full suite covers first/unchanged/replacement sync,
text-only changes, image add/delete/reorder/content replacement, multiple
notes, target isolation, old-active preservation, upload expiry/reuse,
permission and retry halts, pagination/ownership ambiguity, cleanup
orthogonality, and restart behavior.

## Automated command results

| Command                                                         | Exit | Result                                                                                                                                  |
| --------------------------------------------------------------- | ---: | --------------------------------------------------------------------------------------------------------------------------------------- |
| Direct Vite+ test CLI, final per-attempt/root/property gate     |    0 | 3 files; 77 tests passed.                                                                                                               |
| Direct Vite+ test CLI, final metadata-store matrix              |    0 | 1 file; 42 tests passed.                                                                                                                |
| Direct Vite+ test CLI, executor plus depth-4 explorer           |    0 | 2 files; 25 tests passed.                                                                                                               |
| Direct Vite+ test CLI, final full suite                         |    0 | 40 files; 476 tests passed.                                                                                                             |
| One-off explorer metrics runner                                 |    0 | Depth 4; 276 states; 294 edges; 19 pruned; 630 restart checks; 27/27 transitions; no counterexample. Temporary runner deleted.          |
| `vp check` on 12 changed TypeScript files                       |    0 | All formatted; 0 warnings, lint errors, or type errors.                                                                                 |
| `vp fmt --check` on seven changed documents plus `package.json` |    0 | All eight targeted files satisfy the repository formatter.                                                                              |
| `vp run build`                                                  |    0 | Production build completed; generated manifest retains Zotero `9.0`–`9.0.*`.                                                            |
| Documented `pnpm exec esbuild` smoke-bundle command             |    1 | This review shell did not expose `pnpm`; no bundle was produced by this invocation.                                                     |
| Bundled Node plus installed `esbuild` smoke-bundle command      |    0 | Produced a 736,937-byte bundle with the production adapter entry points; bundle was inspected, never executed, and then deleted.        |
| `vp run typecheck`                                              |    1 | 13 pre-existing third-party Vite+ declaration diagnostics, all under `node_modules`; no `skipLibCheck` used.                            |
| `git diff --check`                                              |    0 | No whitespace errors.                                                                                                                   |
| `vp run verify`                                                 |    1 | Repository-wide formatter stops on 120 known pre-existing full-repository formatting files; feature files are checked separately above. |

No dependency or workflow was changed to manufacture a pass. No assertion was
weakened. The sole full-suite compatibility edit strengthened an old source
regex from parameterless `beforeMutation()` to the exact
`attempt: 1`/`blocks.update` context.

## Manual and release status

- Zotero 9.0.6 production adapter/store smoke: **PENDING USER RUN**.
- Zotero 9 plugin E2E: not run; no XPI exists.
- Zotero 10 runtime/plugin E2E: not run and outside the initial RC.
- Separate Notion test database E2E: not run.
- GitHub Actions for the new local SHA: not run because the branch is not
  pushed.
- Draft PR #1: not modified.
- Release readiness: **not established**.

The next gate is the user's structured production-adapter smoke result from a
disposable Zotero 9.0.6 profile. A smoke PASS permits a later request for push
authorization; it does not authorize XPI creation, installation, live Notion
testing, manifest broadening, Ready-for-review, merge, or release.
