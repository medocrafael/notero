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
- Legacy/unverified metadata is copied into a new marked canonical container;
  old blocks are retained unchanged with a visible migration notice.
- A schema-v2 transaction journal is persisted before remote writes and
  recovers container/candidate operations across process restarts.
- The previous active note remains until a complete candidate and recovery
  record exist. After `old-delete-confirmed`, that complete candidate is first
  promoted as the old source's last-known-good active block before a changed
  source may start.
- Container and candidate create uncertainty has an attempt-specific marker,
  durable two-minute deadline, strict bounded reconciliation, and a final
  zero-match exit path. Proven-unexecuted 400/401/403 creates roll back to the
  safe pre-create stage.
- A 404 is never treated as deletion proof; only an exact delete response with
  `in_trash: true` confirms deletion.
- Provisional File Upload IDs/status are persisted immediately as distinct
  `created-unsent`, `send-uncertain`, `uploaded`, and `attached` states.
  Created-unsent uploads can send once; send-uncertain uploads are
  retrieve-only.
- Every definitely attached upload is recorded with null expiry and remains
  reusable after candidate cleanup and the original one-hour deadline.
- A moved note never changes the global canonical container.

## Images and compatibility

- PNG, JPEG, GIF, and WebP are supported. SVG and animated PNG are explicitly
  unsupported for this release candidate.
- Corrupt/truncated files, forged MIME, decoder failures, SVG, APNG, AVIF, BMP,
  and other unsupported formats stop safely with the old valid note intact.
- Image sync defaults off. Off mode performs no attachment lookup, image read,
  File Upload request, image-only workspace-limit request, or image metadata
  write.
- Feature OFF with a legacy manual token performs no `users.me()` request. It
  uses a persisted random local target identity, with a domain-separated token
  fingerprint only as a non-workspace fallback when local persistence fails.
  The creator returned with each managed block is persisted and verified on
  later mutations.
- Uploads are serial, with defaults of 32 image occurrences and 100 MiB total
  image bytes per note.
- Zotero main-window Blob/FormData/fetch/crypto adapters prevent cross-realm
  multipart objects from being hidden by Node/jsdom test globals.

## Retry policy

HTTP 429 honors `Retry-After`; proven-unexecuted safe retries use bounded
exponential backoff with jitter. HTTP 500/502/503/504/529, timeouts, and network
failures after File Upload creation are result-uncertain and are never replayed.
They use exact list reconciliation and a durable isolation deadline. HTTP
401/403 are not retried.

## Verification

The automated matrix covers ownership attacks, ordered parser-to-block output,
crash stages, delete uncertainty, provisional uploads, metadata recovery,
feature-off behavior, retry timing, real image fixtures, realm adapters, and
resource limits. The isolated real Zotero 10 plus test Notion multipart smoke
test remains not run and is documented in
`docs/embedded-note-image-sync-manual-test.md`.

No XPI or release is produced by this review-remediation change.

The CI artifact name resembles an XPI, but the unchanged workflow archives the
`build/` directory as a ZIP and does not run `create-xpi`. That artifact is not
a release candidate and must not be installed.
