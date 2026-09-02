# Final directed RC remediation red checkpoint

## Scope

- Branch: `feature/sync-embedded-note-images`
- Starting SHA: `805ad77e5e1257a882a88ca990a2723b5ed5c789`
- Baseline `main`: `265c1711507d8f03305325cabe350543cfe1e4b1`
- Production files changed before this run: none
- Production Zotero/Notion data accessed: none

## Command

The bundled Node.js `v24.19.0` executed the repository-local Vite+ test CLI:

```text
vite-plus-test run
  src/content/sync/note-sync-transaction/__tests__/upload-mutation-reauthorization-v4.spec.ts
  src/content/sync/note-sync-transaction/__tests__/metadata-store-v4.spec.ts
  src/content/sync/note-sync-transaction/__tests__/model-canonicalization-v4.spec.ts
  src/content/sync/note-sync-transaction/__tests__/runtime-adapter-v4.spec.ts
```

## Result

```text
Test Files  4 failed (4)
Tests       17 failed | 38 passed (55)
Exit        1
```

The failures were behavioral assertions rather than fixture import, transform,
or setup failures.

## Finding-to-red-test evidence

| Finding | Red tests | Initial failure                                                                                                                                                                                    |
| ------- | --------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-H01   |         4 | Create ran after `onCreateStarted` supersession; retry attempt 2 ran after intent replacement; send ran after session replacement; only the gateway-level audit preceded both SDK create attempts. |
| R-H02   |         4 | A stale note loaded C1 instead of canonical C2; an ordinary note delta replaced root C2; a post-repair B write observed C1; cleanup metadata rolled root C2 back to C1.                            |
| R-M01   |         5 | Canonical keys merged states with different identity sequence, invocation count, fake next resource IDs, armed failpoints, and scheduler history.                                                  |
| R-M02   |         1 | `package.json` still declared `zoteroMaxVersion: 10.0.*` instead of the isolated Zotero 9 RC scope.                                                                                                |
| R-L01   |         3 | Candidate, upload-create, and upload-send records remained `VALID` after changing `expectedCreator` and recomputing the request digest.                                                            |

The companion send-uncertainty restart test passed: one ambiguous send was
followed only by retrieve/observation and the SDK send count remained one.
