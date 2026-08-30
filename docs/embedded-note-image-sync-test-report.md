# Embedded Note Image Sync State-Machine Test Report

## Environment

- Branch: `feature/sync-embedded-note-images`
- Approved refactor starting SHA: `be54fa1eba478cd6e2519743c8439c0b75545800`
- Node.js: `v24.19.0`
- Package manager declaration: `pnpm@10.33.2`
- Vite+: `0.1.21`
- Notion SDK: `@notionhq/client` `4.0.1`
- Zotero target: `10.0` through `10.0.*`

No production Zotero profile, Notion workspace, token, database, note, paper,
or image was accessed. No XPI was generated or installed.

## Architecture verification

- Nine closed main states and `INTENDED | UNCERTAIN` operation phases.
- Strict JSON, field, and transaction-invariant validation.
- Pure reducer with no API, file, persistence, clock, or random dependency.
- Real `recordRevision` compare-and-swap and stale-writer reload behavior.
- Persist-intent-before-remote ordering for all remote mutations.
- One observation path for normal execution and complete-process restart.
- Local-only `COMMIT_ACTIVE`; no remote promotion after candidate durability.
- Unified exact `DELETE_BLOCK` protocol; 404 never proves deletion.
- Append uncertainty abandons the candidate and never replays the batch.
- Upload-send restart is retrieve-only and never resends bytes.
- Exact root canonical-container target scope prevents cross-workspace adoption.
- Formal-main legacy IDs are immutable evidence; feature-v2 stages are
  quarantined and have no recovery runtime.

## Reducer and model coverage

`reducer.spec.ts` implements table-driven transitions T1-T23. The suite covers
success, illegal events, local-only commit, source change before/after
durability, cleanup, quarantine, and explicit repair.

`model.spec.ts` explores state × event × failpoint × restart to depth 12 after
canonicalization. It checks:

- P1 last-known-good active preservation;
- P2 exact verified destructive intent;
- P3 at most one authoritative active after convergence;
- P4 repeated recovery adds no remote effect;
- P5 progress or explicit quarantine;
- P6 safe source supersession;
- P7 Feature OFF upload count zero;
- P8 every destructive effect has matching durable intent;
- P9 active commit references durable candidate evidence;
- P10 404/zero/multiple-match observations never become success.

## Executor and crash coverage

- crash before intent persistence: zero remote operation;
- remote success then crash before observation persistence: restart observes
  the same operation ID and request digest;
- uncertainty is persisted and bounded rather than automatically looped;
- JSON restart preserves exact operation identity;
- two stale writers cannot overwrite the same record revision;
- event log ordering proves persisted intent precedes remote mutation;
- H-01: candidate durable -> local active commit -> delete intent persisted ->
  old remote delete succeeds -> crash before delete confirmation -> restart
  keeps the new active, observes the same delete, completes cleanup, and remains
  usable without a second delete.

## Notion adapter coverage

- exact live delete and exact `in_trash=true` proof;
- permission/absence 404 remains unknown;
- creator, parent, marker, version, and last-edited changes prevent delete;
- exact already-trashed observation succeeds only under the persisted intent;
- duplicate exact create markers and incomplete pagination remain uncertain;
- edited staging candidates are abandoned before append;
- archived/trashed finalized-looking candidates cannot commit;
- append observation never replays content;
- upload-send observation never resends bytes.

## Production integration coverage

- first native-v3 sync, immediate unchanged sync, and text replacement;
- previous active remains until durable local commit and is deleted afterward;
- 101 content blocks are written in two batches and only complete content is
  authoritative;
- Feature OFF performs zero image lookup/read/upload/metadata writes;
- attached upload reuse after text-only changes;
- image add, delete, reorder, and same-key content replacement;
- multiple child notes share one canonical container and remain independent;
- formal-main legacy migration preserves old blocks untouched;
- a canonical container from another target scope is rejected before any
  remote mutation;
- corrupt, future, and feature-v2 metadata is preserved and isolated.

Existing suites retain parser ordering, nested inline images, resolver library
identity, PNG/JPEG/GIF/WebP validation, malformed bytes, File Upload lifecycle,
bounded retries, ownership markers, preference default/feature-off behavior,
and text conversion regression coverage.

## Commands and results

| Command                                                                                          | Exit | Result                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ---: | ------------------------------------------------------------------------------------------------------ |
| Bundled Node + direct Oxfmt with the repository's Vite+ format options, changed files, `--check` |    0 | 33 changed TS/Markdown files formatted.                                                                |
| Bundled Node + direct Oxlint with the repository's categories/plugins/rules, changed TS files    |    0 | 0 warnings, 0 errors across 28 files.                                                                  |
| Direct Vite+ test CLI, full suite                                                                |    0 | 32 test files, 344 tests passed.                                                                       |
| Direct Vite+ test CLI, model/reducer suites (also included above)                                |    0 | T1-T23 and P1-P10 passed.                                                                              |
| Standalone Vitest entry (diagnostic attempt)                                                     |    1 | Test collection stopped before assertions because the repository setup requires the Vite+ mocks entry. |
| `tsc --noEmit --pretty false`                                                                    |    2 | 0 `src/` errors; 13 pre-existing third-party Vite+ declaration errors under `node_modules`.            |
| Bundled Node `scripts/build.mts`                                                                 |    0 | Production build completed.                                                                            |
| `git diff --check`                                                                               |    0 | No whitespace errors.                                                                                  |
| Bundled Node `node_modules/vite-plus/bin/vp fmt --check`                                         |    1 | Environment/tool wrapper cannot resolve its internal `node` binary.                                    |
| Bundled Node `node_modules/vite-plus/bin/vp lint`                                                |    1 | Same Vite+ internal Node resolution failure.                                                           |
| Bundled Node `node_modules/vite-plus/bin/vp check`                                               |    1 | Same Vite+ internal Node resolution failure; repository `verify` cannot start through the wrapper.     |

The Vite+ wrapper and third-party declaration failures were present at
baseline and were not suppressed, patched, or hidden. Equivalent formatter,
linter, tests, and production build were run directly with the checked-in
versions. The unrelated repository-wide formatting drift recorded at baseline
was not reformatted.

## Manual validation status

The dedicated Zotero 10 development-profile plus separate Notion test-database
validation is **not run**. This is intentional under the current instruction to
avoid real Zotero/Notion access. The checklist is in
`docs/embedded-note-image-sync-manual-test.md`.

## Packaging and release status

- XPI packaging: not run and prohibited for this refactor round.
- XPI checksum: not applicable.
- Release: not created.
- Merge: not performed.
- Production installation: not performed.
- Exact final source commit: reported in the Draft PR and final implementation
  report after the commit is created (a committed file cannot self-reference
  its own final SHA).
