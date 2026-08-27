# Embedded Note Image Sync Review Remediation Test Report

## Environment

- Working branch: `feature/sync-embedded-note-images`
- Reviewed starting commit: `fe7300ebf665c42d965bc8550775193eaf73e10c`
- Node.js: `v24.19.0`
- Package manager declaration: `pnpm@10.33.2`
- Vite+: `0.1.21`
- Notion SDK: `@notionhq/client` `4.0.1`
- Zotero target: `10.0` through `10.0.*`

No production Zotero profile, Notion workspace, token, database, paper, note,
or image was accessed. No XPI was generated or installed.

## Baseline before remediation

The following results were recorded on the reviewed commit before the repair:

| Command              | Exit | Result                                                                         |
| -------------------- | ---: | ------------------------------------------------------------------------------ |
| `pnpm run fmt:check` |    1 | Existing formatting drift in 124 checked-in files.                             |
| `pnpm run lint`      |    0 | 16 existing `no-underscore-dangle` warnings, 0 errors.                         |
| `pnpm run typecheck` |    1 | Third-party Vite+ declaration resolution/conflict errors under `node_modules`. |
| `pnpm run test`      |    0 | 21 test files and 223 tests passed.                                            |
| `pnpm run build`     |    0 | Production build succeeded.                                                    |

The repository-wide format and third-party declaration failures were not
changed, suppressed, or hidden.

## Tests-first evidence

Each reviewed finding was reproduced before its implementation repair. The red
runs included:

- 11 parser/resolver failures for wrapper images, structural image validation,
  SVG safety, and Zotero realm behavior;
- 20 metadata/coordinator failures for hostile IDs, 404 uncertainty, restart
  stages, canonical-container isolation, partial corruption, and resource
  limits;
- 5 upload/feature-off failures for `Retry-After`, retry budgets, upload create
  reconciliation, and image-only `users.me()` calls;
- 2 additional adversarial failures showing a known provisional upload ID was
  lost after an interrupted send and an unprovable create could be repeated;
- 1 additional ownership race failure showing a moved candidate was not
  revalidated immediately before active-block deletion;
- 1 compatibility failure showing adjacent Notion marker runs could be merged
  on retrieval.

The tests were then made green by changing production behavior. Assertions and
quality gates were not weakened.

## Automated coverage

- Remote ownership verification for canonical container, active note, and
  candidate blocks, including user/other-note/other-container/other-page/
  other-bot attacks and unverified legacy metadata.
- Ordered parser-to-block rendering for paragraphs, headings, lists, quotes,
  anchors, spans, strong text, deep wrappers, and alternating multiple images.
- Discovery/resolution/preparation/render count invariants and changed-source
  rejection when an image block is missing.
- Durable restart recovery at container create, candidate create, partial/full
  append, title update, candidate persistence, old deletion, promotion, and
  orphan cleanup.
- Permission-hidden and API-indistinguishable 404 behavior plus exact
  `in_trash: true` delete confirmation.
- Provisional upload persistence, partial failure reuse, send restart retrieve,
  create list reconciliation, unknown-create quarantine, expiry, and failed
  upload rejection.
- Canonical-container isolation after a note is manually moved.
- Schema-v2 per-note recovery, partial corruption, legacy schema, future fields,
  redacted diagnostics, and healthy sibling notes.
- Zotero main-window Blob/FormData/fetch/crypto realm behavior.
- Integer/date/invalid `Retry-After`, bounded jittered retry, 401/403 no retry,
  maximum attempts, and total wait budget.
- Feature-off attachment/file/upload/user-limit/metadata behavior.
- Real minimal PNG/JPEG/GIF/WebP fixtures, safe XML SVG, truncated/forged files,
  and unsafe SVG.
- Image count, aggregate bytes, serial upload, and one-image byte lifetime.

## Final automated verification

| Command                                    | Exit | Result                                                                   |
| ------------------------------------------ | ---: | ------------------------------------------------------------------------ |
| `pnpm run generate-fluent-types`           |    0 | Generated locale types successfully.                                     |
| `pnpm run test -- <10 related test files>` |    0 | 10 files and 149 tests passed.                                           |
| `pnpm run test`                            |    0 | 23 files and 287 tests passed.                                           |
| `pnpm run build`                           |    0 | Production build succeeded; no XPI task was invoked.                     |
| `pnpm run lint -- <changed files>`         |    0 | 0 warnings and 0 errors.                                                 |
| `pnpm run lint`                            |    0 | 16 unchanged baseline warnings and 0 errors.                             |
| `pnpm run fmt -- --check <changed files>`  |    0 | All 24 matched files use the correct format.                             |
| `pnpm run fmt -- --check .`                |    1 | The same 124 repository baseline files report formatting drift.          |
| `pnpm run check`                           |    1 | Stops on the same 124-file formatting baseline.                          |
| `pnpm run typecheck`                       |    1 | Only the existing Vite+ package declaration errors under `node_modules`. |
| `git diff --check`                         |    0 | No whitespace errors.                                                    |

No `skipLibCheck`, assertion reduction, workflow change, dependency upgrade, or
unrelated formatting change was used to manufacture a passing result.

## Adversarial review

The final diff was searched for raw-ID deletion authority, legacy orphan
cleanup, 404-as-absence logic, image-to-empty-rich-text success, unbounded
loops/retries, image-only calls while disabled, source data writes, secrets,
XPI generation, and unrelated dependency/workflow edits.

Additional issues found and fixed during this review were:

- interrupted send recovery discarded a known upload ID and could create a new
  upload on restart;
- an unknown upload create outcome lacked a conservative no-recreate window;
- candidate ownership was not revalidated immediately before old-block
  deletion;
- exact rich-text element matching could fail safely but unnecessarily when
  Notion merged adjacent marker runs;
- new tests initially introduced lint errors, all of which were removed before
  final verification.

## Manual status

Not run. The required real Zotero 10 plus test-only Notion multipart smoke test
and all isolated end-to-end cases remain pending. See
`embedded-note-image-sync-manual-test.md`. Production data must not be used as a
substitute.
