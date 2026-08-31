# FSM v2 final review red-test checkpoint

- Starting commit: `dfdb7120ec5d64912e834d0eefa47418419d1ce1`
- Branch: `feature/sync-embedded-note-images`
- Recorded at: 2026-09-01 (Asia/Shanghai)
- Exit status: `1` (expected red checkpoint)
- Collection status: all 5 requested test files collected; no compile, import, or collection failures
- Result: 15 failed, 24 passed, 39 total

## Command

```powershell
& $nodeExe $runner run `
  src/content/sync/note-sync-transaction/__tests__/runtime-adapter-v4.spec.ts `
  src/content/sync/note-sync-transaction/__tests__/notion-operation-adapter-v4.spec.ts `
  src/content/sync/note-sync-transaction/__tests__/final-review-findings-v2.spec.ts `
  src/content/sync/__tests__/sync-note-item-stateful.spec.ts `
  src/content/sync/__tests__/sync-feature-off.spec.ts
```

The executable variables resolved to the bundled Node 24.19.0 runtime and the
repository-installed Vite+ test runner. They are intentionally not recorded as
machine-specific absolute paths.

## Expected failures

1. C-01: runtime adapter preserves DB and Items method receivers.
2. C-01: production `syncNoteItem` path preserves Zotero method receivers.
3. H-01: legacy local identity remains distinct from the learned remote creator.
4. H-01: Feature OFF to ON preserves local connection identity.
5. H-02: candidates use an explicit staging title instead of the final title.
6. H-02: failed replacement remains staged and outside the active mapping.
7. H-03: a persisted recovery transition exists for the candidate-create sink.
8. H-04: every uncertain cleanup cycle advances durable attempt evidence.
9. H-05: `expired` plus `archived=true` is recognized as an expired upload.
10. H-06: copied manifest digests are rejected unless canonically recomputable.
11. H-06: one File Upload ID cannot be bound to two different assets.
12. M-01: coordinator and model do not maintain second planning sources.
13. M-02: reducer replay is deterministic from a frozen record and event.
14. M-03: metadata safely round-trips a closing `pre` plus `script` payload.
15. M-03: metadata safely round-trips HTML metacharacters without entity drift.

The remaining Unicode, emoji, line-separator, and zero-width metadata cases
already passed. They remain in the parameterized test as regression coverage.
