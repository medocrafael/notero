# Embedded Note Image Sync — FSM v2 Automated Test Report

## Status and environment

- Branch: `feature/sync-embedded-note-images`
- Approved implementation start: `d6c7d844aeb710f7f1d11ee6c2692dddb134c867`
- Baseline `main`: `265c1711507d8f03305325cabe350543cfe1e4b1`
- Node.js: `v24.19.0`
- Package manager declaration: `pnpm@10.33.2`
- Vite+: `0.1.21`
- Notion SDK: `@notionhq/client` `4.0.1`
- Add-on compatibility declaration: Zotero `9.0` through `10.0.*`

No production Zotero profile, Notion workspace, token, database, note, paper,
or image was accessed. No plugin was installed. No XPI was generated, installed,
or published.

The supplied isolated Zotero 9.0.6 transaction spike is accepted as runtime
evidence for `executeTransaction` plus fresh reload, revision comparison,
immutable merge, `attachment.save()`, and serialized concurrent callbacks. It
was not rerun against production data. Zotero 10 is a code-compatible target;
runtime validation remains pending.

## Tests-first evidence

Commit `9451c7b` (`test(sync): Reproduce FSM v2 review findings`) preserves the
red checkpoint for H-01 through H-05, M-01 through M-05, and L-01 before the
production replacement. The finding-to-test mapping and captured red behavior
are recorded in `docs/embedded-note-image-sync-fsm-v2-findings.md`.

## Architecture checks

The verified production path contains:

- exactly seven main states: `IDLE`, `PREPARING`, `CANDIDATE_CREATING`,
  `CANDIDATE_WRITING`, `CANDIDATE_VERIFYING`, `CANDIDATE_DURABLE`, and
  `QUARANTINED`;
- an orthogonal cleanup ledger with `PENDING`, `DELETE_INTENDED`,
  `DELETE_UNCERTAIN`, `QUARANTINED`, and `CONFIRMED`;
- schema v4 plus central V1–V18 cross-field validation;
- real Zotero `executeTransaction` compare–merge–write with one root and note
  revision increment per atomic mutation;
- durable exact intent and writer lease before every remote mutation;
- immediate ownership revalidation before ownership-sensitive writes;
- local-only durable-candidate commit, with old active cleanup enqueued but not
  awaited;
- latest-wins source coalescing and a one-shot forced-liveness trigger;
- sealed ambiguity/quarantine evidence and a same-run permanent-error halt;
- explicit Notion API version `2022-06-28` on JSON and multipart transports;
- one production transition registry, M01–M24, used by selectors, reducers,
  observers, and tests;
- a unified `RuntimeClock` for transaction time, deadlines, expiry, leases,
  retry timing, and model time advancement.

The FSM v1 production modules and their parallel tests were removed. Source
scans find no production `ACTIVE_COMMITTED` or `CLEANING` main state, no old
v1 imports, no transaction `saveTx()`, and no direct transaction time calls
outside the `RuntimeClock` adapter.

## P1–P15 and stateful integration

`properties-v4.spec.ts` contains exactly one reducer/table case and one
stateful Notion case for every property P1–P15. All 32 tests pass, including:

- LKG preservation across remote success/local persistence failure;
- fail-closed move, edit, ownership-marker mismatch, 404, archived-only, and
  incomplete deletion evidence;
- durable intent/lease audit for each mutation;
- restart recovery without blind replay;
- source B/C coalescing while cleanup remains unresolved;
- Feature OFF with zero upload/image-block/image-metadata work;
- unchanged resync as a no-op;
- complete durability proof before active commit;
- bounded main, mutation, cleanup, retry, and metadata behavior;
- cleanup uncertainty/quarantine remaining orthogonal to future generations;
- permanent permission failure attempted at most once in one run;
- IDLE stale mapping detection after TTL.

The full stateful sync regression additionally verifies first sync, unchanged
sync, text-only replacement, attached-upload reuse, image add/delete/reorder,
same-source-identity byte replacement, multiple notes, legacy preservation,
and target isolation.

## Deterministic model explorer

The explorer serializes the complete schema-v4 root through the production
parser for every persisted state. A process restart creates new coordinator,
executor, adapters, run context, lock/session identity, and metadata-store
instances while retaining only serialized durable metadata and the stateful
fake Notion server.

Depth-4 deterministic exploration produced:

| Metric                           |  Result |
| -------------------------------- | ------: |
| Canonical states                 |     169 |
| Explored edges                   |     201 |
| Canonically pruned states        |      33 |
| Fresh-process restart checks     |     344 |
| Production transitions covered   | 24 / 24 |
| Missing transition witnesses     |       0 |
| P1–P15 properties with witnesses | 15 / 15 |
| Shortest counterexample          |    none |

The state key retains all nested identity, intent, lease, candidate, completion,
cleanup, upload, evidence, target, revision, remote-resource, permission,
failpoint, and clock fields. Pruning occurs only for byte-identical canonical
JSON states. The explorer uses production registry transitions rather than a
test-owned event set.

During implementation, the explorer found a real forced-liveness livelock:
the process option remained permanently true and repeatedly selected
M03→M22→M23. Production now consumes that process-local request once; the
regression test proves the coordinator returns stable afterward.

## Automated command results

| Command                                                                                                                              | Exit | Result                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Bundled Node + direct Oxfmt using the repository Vite+ format options, all branch-changed supported files, `--check`                 |    0 | 57 changed files formatted.                                                                                                                |
| Bundled Node + direct Oxlint using repository categories/plugins/rules plus `--type-aware --type-check`, all branch-changed TS files |    0 | 50 files; 0 warnings and 0 errors.                                                                                                         |
| Direct Vite+ test CLI, focused executor + P1–P15 + model suites                                                                      |    0 | 56 tests passed.                                                                                                                           |
| Direct Vite+ test CLI, `properties-v4.spec.ts` after lint remediation                                                                |    0 | 32 tests passed.                                                                                                                           |
| Direct Vite+ test CLI, full suite                                                                                                    |    0 | 37 files; 391 tests passed.                                                                                                                |
| Bundled Node `node_modules/typescript/bin/tsc --noEmit`                                                                              |    2 | 13 baseline third-party Vite+ declaration errors; 0 diagnostics under `src/`.                                                              |
| Bundled Node `scripts/build.mts`                                                                                                     |    0 | Production build completed.                                                                                                                |
| `git diff --check`                                                                                                                   |    0 | No whitespace errors.                                                                                                                      |
| `vp run verify`                                                                                                                      |    1 | Local Windows checkout reports the same baseline repository-wide formatting drift: 121 unrelated files. No unrelated file was reformatted. |

The standalone TypeScript and repository-wide Windows formatting failures are
the same isolated baseline conditions recorded before implementation. No
`skipLibCheck`, workflow change, dependency upgrade, broad reformat, or relaxed
assertion was used. The feature-specific formatter, type-aware lint, tests, and
production build pass. Exact-SHA GitHub Actions remain the clean-environment
external gate and are not claimed until the final commit is pushed and checked.

## Manual validation status

Manual Zotero/Notion E2E is **not run** in this implementation round. The
future isolated procedure is in
`docs/embedded-note-image-sync-manual-test.md`; it requires dedicated Zotero 9
and Zotero 10 development profiles, a separate Notion test database, and a
test-only connection. Production data is expressly excluded.

## Packaging and release status

- XPI creation: not run and prohibited for this round.
- Plugin installation: not run.
- Release/update manifest: not created or modified.
- Merge: not performed.
- Draft PR: must remain Draft.
- Independent code review: still pending and required before any isolated RC.
- Final source SHA and exact-SHA Actions URL: reported after the final commit and
  push; a committed report cannot include its own commit SHA.

Passing this report means the branch is eligible for independent read-only code
review only. It does not authorize packaging, installation, publication, or
production use. Notion does not offer a conditional remote CAS for these block
mutations; the implementation therefore remains fail-closed around the
documented ownership revalidation/TOCTOU boundary.
