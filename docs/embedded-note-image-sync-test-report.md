# Embedded Note Image Sync Test Report

## Environment

- Starting branch: `main`
- Starting commit: `265c1711507d8f03305325cabe350543cfe1e4b1`
- Feature branch: `feature/sync-embedded-note-images`
- Node.js: `v24.19.0`
- Repository package manager declaration: `pnpm@10.33.2`
- Initial host pnpm shim: `11.19.0`; dependencies were reinstalled with the
  declared `10.33.2` release.
- Vite+: `0.1.21`
- Notion SDK: `@notionhq/client` `4.0.1`
- Zotero target: `10.0` through `10.0.*`

No production Zotero profile, Notion workspace, token, database, or private
source material was accessed.

## Unmodified baseline

| Command                                              | Exit | Result                                                                                          |
| ---------------------------------------------------- | ---: | ----------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` (host pnpm 11.19.0) |    1 | Initial native-package download interruption; Vite+ binding missing.                            |
| `pnpm install --frozen-lockfile` (retry)             |    0 | Completed, but used host pnpm 11.19.0.                                                          |
| `pnpm dlx pnpm@10.33.2 install --frozen-lockfile`    |    0 | Reinstalled using the repository-declared package manager.                                      |
| `pnpm run fmt:check`                                 |    1 | Existing formatter baseline reports 145 checked-in files.                                       |
| `pnpm run lint`                                      |    0 | 16 existing warnings, no errors.                                                                |
| `pnpm run check`                                     |    1 | Same existing repository-wide formatting failure.                                               |
| `pnpm run typecheck`                                 |    1 | Existing Vite+ declaration errors in `node_modules`; source-only `tsc --skipLibCheck` succeeds. |
| `pnpm run test`                                      |    0 | 15 files and 157 tests passed.                                                                  |
| `node scripts/build.mts` (sandbox)                   |    1 | Environment-only `uv_os_get_passwd` ENOMEM.                                                     |
| `node scripts/build.mts` (outside sandbox)           |    0 | Production build succeeded.                                                                     |

The format and typecheck failures were reproduced before source changes and are
not silently fixed or mixed into this feature.

## Tests-first evidence

The first run after adding tests but before implementation exited 1: four new
test files failed, including missing resolver/upload/lock modules and five IMG
parser/order failures. This established the expected red state before the
implementation.

## Implemented automated coverage

- Explicit standard `IMG` parsing, `data-attachment-key`, `data-annotation`,
  malformed images, nested images, multi-image order, and text-only regression.
- Same-library/same-parent embedded attachment resolution, deleted/wrong type,
  missing/unreadable files, byte signatures, MIME allowlist, size limit, and
  SHA-256 stability.
- Official SDK create/send/retrieve lifecycle, raw `Blob` transfer, 401/403,
  409/429/529/5xx, timeout/network ambiguity, bounded create/status retry,
  expiry, pending status, and target identity comparisons.
- Safe first sync and replacement, failure before candidate creation, append
  failure (including later batches), ambiguous candidate creation recovery, old
  deletion failure/ambiguity, cleanup/orphan state, missing and manually moved
  active blocks, unchanged skip, disabled preference, full image lifecycle,
  cross-target rejection, independent notes, and overlapping sync.
- Legacy and current metadata, syntactically and structurally corrupt metadata,
  complete recovery metadata, SDK log redaction, and project-level error
  isolation.

## Adversarial review

The completed review searched all changed synchronization and persistence paths
for early old-block deletion, `finally` commits, unbounded loops/retries,
ambiguous append replay, cross-target File Upload reuse, source mutation, and
response/path/body logging. Findings fixed during review were:

- target identity lacked an independent workspace component;
- an unchanged mapping skipped even if its active block was deleted;
- first-sync candidate failure could leave an empty container;
- ambiguous candidate creation had no bounded lookup by stable attempt marker;
- structurally corrupt metadata could be partially accepted and overwritten;
- image hashing and Blob construction made redundant full-size byte copies;
- add/delete/replace/reorder and multi-note isolation needed coordinator-level
  coverage;
- SDK logging needed an explicit response-body/token regression test.

The final diff contains no old-block deletion before complete candidate
persistence and no state commit in a `finally` block.

## Final verification

| Command                                               | Exit | Result                                                                                        |
| ----------------------------------------------------- | ---: | --------------------------------------------------------------------------------------------- |
| `node scripts/generate-fluent-types.mts`              |    0 | Locale type generation succeeded; Windows-only comment separator was normalized back.         |
| `pnpm dlx pnpm@10.33.2 run fmt:check`                 |    1 | Existing repository-wide formatting drift remains in 124 files after feature files are clean. |
| `pnpm dlx pnpm@10.33.2 run lint`                      |    0 | 16 baseline `no-underscore-dangle` warnings, 0 errors.                                        |
| `pnpm dlx pnpm@10.33.2 run check`                     |    1 | Stops on the same 124-file pre-existing formatting drift.                                     |
| `pnpm dlx pnpm@10.33.2 run typecheck`                 |    1 | Only Vite+ package declaration failures under `node_modules`; unchanged from baseline.        |
| `node node_modules/typescript/bin/tsc --skipLibCheck` |    0 | Repository source type-check succeeds.                                                        |
| `pnpm dlx pnpm@10.33.2 run test`                      |    0 | 21 test files and 223 tests passed.                                                           |
| `pnpm dlx pnpm@10.33.2 run build`                     |    0 | Production build succeeded.                                                                   |

The feature's explicit changed-file formatter check and `git diff --check`
also succeed. No release-candidate XPI was generated because the required full
format/check/typecheck gates are not all green. This follows the packaging gate
instead of changing 124 unrelated files or suppressing third-party declaration
errors.

## Manual status

Not run. See `docs/embedded-note-image-sync-manual-test.md`. No production data
may be substituted for the required isolated environment.
