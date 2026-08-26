# PR: Sync images embedded in Zotero notes

Closes #385.

## Summary

This change adds opt-in synchronization of standard images embedded in Zotero
10 child notes. Image bytes are resolved locally through supported Zotero APIs
and uploaded directly to Notion through the official File Upload API introduced
after the original issue was filed (also related to #772).

Text and images retain source order. The existing note is kept until a complete
candidate replacement has been written, persisted as recoverable state, and
the previous block has been safely removed.

## Safety and privacy

- Image sync defaults off and performs no image lookup or upload while off.
- No public host, temporary URL, relay, tunnel, or Zotero database access is
  used.
- Upload cache entries are scoped by Notion connection, workspace, database,
  and page.
- Same-parent note operations are serialized and same-note identity remains
  explicit, preventing mapping races between automatic and manual sync.
- Append requests are never blindly retried after ambiguous failures; the whole
  candidate is discarded or recovered.
- Existing valid notes and mappings remain active on pre-commit failure.
- SDK logging is reduced to WARN and response bodies/payloads are not forwarded
  to Notero logs. Local path errors are redacted.

## Supported images

GIF, JPEG, PNG, SVG, and WebP standard Zotero embedded-image attachments are
supported. Formats outside Notion's official File Upload image allowlist are
rejected before upload.

## Test plan

- Parser and ordering tests for text, headings, lists, quotes, equations, and
  multiple images.
- Resolver MIME/size/hash and attachment ownership tests.
- Upload lifecycle, error, expiry, bounded retry, and target-isolation tests.
- Transaction, rollback, recovery, idempotency, concurrency, and compatibility
  tests.
- Isolated manual validation using a dedicated Zotero profile and separate
  Notion test database, documented in
  `docs/embedded-note-image-sync-manual-test.md`.

## Release status

No upstream PR or public release has been created. No XPI was produced because
the repository-wide formatting and third-party declaration gates described in
the test report remain red.
