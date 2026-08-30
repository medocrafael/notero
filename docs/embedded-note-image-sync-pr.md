# PR: Sync images embedded in Zotero notes

Closes #385. Related File Upload API context: #772.

## Summary

This Draft PR adds opt-in synchronization of standard images embedded in
Zotero 10 child notes. Local image bytes are resolved through supported Zotero
APIs, validated, and uploaded directly through Notion's official File Upload
API. Text and image blocks retain their source order.

Transaction state-machine redesign completed; isolated RC still pending
independent review.

## Transaction architecture

- Replaced the feature-v2 free-form stage journal and `recoverTransaction()`
  family with a strict nine-state `NoteSyncRecordV3`.
- Added a pure reducer with table-driven T1-T23 tests and a bounded deterministic
  state-space explorer for P1-P10.
- Added a CAS metadata store. `recordRevision` rejects stale writes and causes
  reload, revalidation, and transition reselection.
- Every remote mutation follows reducer effect -> persisted operation intent ->
  remote action -> exact observation -> reducer event -> persisted next state.
- `CANDIDATE_DURABLE` is already the final remote form. `COMMIT_ACTIVE` changes
  only the authoritative local pointer and performs no remote promotion.
- Unified all managed cleanup under an exact `DELETE_BLOCK` intent. 404 is
  unknown, never deletion proof.
- Create reconciliation uses exact creator/parent/ownership/version markers;
  append uncertainty abandons the candidate; upload-send recovery is
  retrieve-only.

## Safety

- The previous active note remains authoritative until the complete finalized
  candidate commits locally.
- Old active deletion begins only after the new active pointer is durable.
- H-01 is covered: crash after old remote delete but before confirmation
  persistence restarts from the same `DELETE_INTENT`, preserves the new active,
  and reconciles without a second delete.
- Canonical container evidence is scoped to exact connection, workspace,
  database, page, Zotero library, and parent item identity.
- Moved, edited, differently created, archived, trashed, or differently marked
  resources cannot be adopted or mutated.
- Bare formal-main legacy IDs remain immutable evidence. The v3 path creates a
  new managed copy and leaves legacy remote content untouched.
- Unpublished feature-v2 stages are quarantined; there is no old/new dual
  recovery runtime.

## Images and privacy

- Image sync remains explicitly opt-in and defaults off.
- OFF performs no image lookup, local file read, File Upload call, or upload
  metadata write.
- PNG, JPEG, GIF, and WebP are supported under the existing direct-upload,
  image-count, and aggregate-byte limits.
- No public intermediary URL or third-party media relay is used.
- Deterministic filename plus exact target/attachment/content-hash identity
  prevents unchanged re-uploads.
- Notion documents File Upload IDs as reusable across blocks/pages, including
  after deletion of original content:
  <https://developers.notion.com/guides/data-apis/uploading-small-files>.

## Automated coverage

- T1-T23 reducer transitions, illegal events, JSON round trips, crash/restart,
  persistence failures, and uncertainty.
- P1-P10 via bounded BFS to depth 12.
- stale writers, intent-before-remote ordering, lost responses, and H-01.
- exact delete/404/ownership, duplicate markers, incomplete pagination,
  archived/trashed finalization, append non-replay, and upload-send non-replay.
- 101-block batching, Feature OFF, upload reuse after text-only change, multiple
  notes, legacy migration, and cross-target container isolation.
- Existing parser, ordering, resolver, MIME/byte validation, retry, ownership,
  and feature preference suites.

## Manual status

The isolated Zotero 10 plus test-only Notion multipart validation remains not
run. Follow `docs/embedded-note-image-sync-manual-test.md` with a dedicated
Zotero development profile and separate Notion test database.

No XPI was generated or installed. No release, merge, update-manifest change,
or production Zotero/Notion access is part of this Draft PR update.
