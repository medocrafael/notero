# PR: Sync images embedded in Zotero notes

Closes #385. Related API context: #772.

## Summary

This change adds opt-in synchronization of standard images embedded in Zotero
10 child notes. Bytes are resolved locally through supported Zotero APIs and
uploaded directly through Notion's official File Upload API. Text and images
retain their source order, including images nested in supported inline
wrappers.

## Safety and recovery

- Bare block IDs never authorize mutation. Canonical containers, notes, and
  candidates have remote ownership markers bound to Notion and Zotero identity.
- Legacy/unverified metadata is isolated and preserves remote content.
- A schema-v2 transaction journal is persisted before remote writes and
  recovers container/candidate operations across process restarts.
- The previous active note remains until a complete candidate and recovery
  record exist.
- A 404 is never treated as deletion proof; only an exact delete response with
  `in_trash: true` confirms deletion.
- Provisional File Upload IDs/status are persisted immediately and reconciled
  after interrupted create/send operations without blind replay.
- A moved note never changes the global canonical container.

## Images and compatibility

- PNG, JPEG, GIF, WebP, and safe parsed SVG are supported.
- Corrupt/truncated files, forged MIME, unsafe SVG, and unsupported formats stop
  safely with the old valid note intact.
- Image sync defaults off. Off mode performs no attachment lookup, image read,
  File Upload request, image-only workspace-limit request, or image metadata
  write.
- Uploads are serial, with defaults of 32 image occurrences and 100 MiB total
  image bytes per note.
- Zotero main-window Blob/FormData/fetch/crypto adapters prevent cross-realm
  multipart objects from being hidden by Node/jsdom test globals.

## Retry policy

HTTP 429 honors `Retry-After`; 409, 529, and retryable 5xx responses use bounded
exponential backoff with jitter. HTTP 401/403 are not retried. Attempt count and
total wait are bounded, and ambiguous writes require retrieve/list
reconciliation rather than replay.

## Verification

The automated matrix covers ownership attacks, ordered parser-to-block output,
crash stages, delete uncertainty, provisional uploads, metadata recovery,
feature-off behavior, retry timing, real image fixtures, realm adapters, and
resource limits. The isolated real Zotero 10 plus test Notion multipart smoke
test remains not run and is documented in
`docs/embedded-note-image-sync-manual-test.md`.

No XPI or release is produced by this review-remediation change.
