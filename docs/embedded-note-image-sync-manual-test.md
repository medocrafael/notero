# Embedded Note Image Sync Manual Validation

## Safety prerequisites

- [ ] Create a dedicated Zotero 10 development profile. Do not open a
      production profile during validation.
- [ ] Create a synthetic Zotero test library with no private papers or notes.
- [ ] Create a separate Notion test workspace/database and authorize a
      test-only Notero connection.
- [ ] Confirm that no production token, database ID, item key, note text, or
      local path is present in logs or fixtures.
- [ ] Use a future isolated release-candidate build only after the repository
      gates pass. This remediation round does not generate or install an XPI.

## Synthetic source note

Create a regular Zotero item with one child note containing, in order:

1. a heading;
2. paragraphs with bold, italic, and linked text;
3. a list, quote, and supported equation;
4. text before, between, and after two PDF area-annotation images;
5. a pasted PNG or JPEG represented as a standard embedded attachment;
6. an image inside each supported inline wrapper used by the test matrix.

Use only synthetic image content. Confirm every image is owned by the child
note through Zotero's supported embedded-image API.

## Multipart and realm smoke test

- [ ] Run a real Zotero 10 Gecko multipart upload against the test-only Notion
      connection.
- [ ] Confirm Blob, FormData, fetch, `crypto.subtle`, and `randomUUID()` all
      originate from the Zotero main-window realm.
- [ ] Confirm the uploaded image is attached through a Notion `file_upload`
      image block and no public intermediary URL is used.

This smoke test is required before release-candidate acceptance and is
currently **not run**.

## Functional cases

- [ ] With image sync off, synchronize the note. Confirm text-only request
      order and metadata match the established behavior, no image file is read,
      no File Upload API is called, and no image-only `users.me()` request is
      made when the auth context already contains bot/workspace identity.
- [ ] Enable image sync and perform the first sync. Confirm all text and image
      blocks remain in source order.
- [ ] Immediately sync again. Confirm one managed note, one image block per
      source occurrence, and no duplicate upload.
- [ ] Change text only. Confirm image upload IDs are reused.
- [ ] Add, delete, replace, and reorder images in separate runs.
- [ ] Validate supported PNG, JPEG, GIF, WebP, and safe SVG sources.
- [ ] Try truncated, forged-MIME, unsafe SVG, APNG, AVIF, and BMP sources.
      Confirm the old valid note remains and the error is actionable.
- [ ] Exceed 32 image occurrences and 100 MiB aggregate image bytes in
      synthetic boundary tests. Confirm failure occurs before remote writes.

## Ownership and canonical-container cases

- [ ] Inspect a new canonical container, active note, and candidate. Confirm
      each carries the expected machine marker without a token, note body, or
      local path.
- [ ] Replace local metadata with a syntactically valid user block ID, another
      note ID, another container ID, another page ID, and another bot's block.
      Confirm no unrelated block is updated, archived, or deleted.
- [ ] Load legacy metadata without verifiable markers. Confirm it stops with a
      recovery instruction and preserves remote content.
- [ ] Move note A under a user toggle, attempt to sync note A, then first-sync
      note B. Confirm note A is isolated and note B still uses the verified
      canonical `Zotero Notes` container.

## Crash-recovery cases

Restart Zotero with in-memory state completely lost after each point:

- [ ] container create succeeds but its response is lost;
- [ ] candidate create succeeds;
- [ ] one append batch succeeds;
- [ ] all append batches succeed but metadata save has not completed;
- [ ] candidate title update succeeds;
- [ ] candidate recovery metadata is saved before old deletion;
- [ ] old deletion is positively confirmed before final promotion;
- [ ] orphan cleanup starts.

For every point, confirm no unknown block is deleted, no unbounded duplicate
container/candidate is created, no partial candidate is promoted, and the last
verified version remains available until a complete replacement is recoverable.

## File Upload recovery cases

- [ ] Upload A succeeds and upload B fails; retry and confirm A is not uploaded
      again.
- [ ] All uploads succeed and candidate creation fails; retry and confirm known
      valid upload IDs are reused before expiry.
- [ ] Interrupt after create returns an ID but during send; restart and confirm
      status is retrieved before any new create/send.
- [ ] Lose the create response. Confirm list reconciliation accepts exactly one
      deterministic recent match and stops on zero or multiple matches.
- [ ] Confirm unknown create results remain quarantined until conservative
      expiry rather than being blindly recreated.
- [ ] Confirm expired and failed uploads are never reused.

## Delete and permission cases

- [ ] Lose a delete response, then remove page sharing so retrieve returns 404.
      Confirm deletion remains uncertain, the candidate recovery record remains,
      and no promotion occurs.
- [ ] Produce an API-indistinguishable true absence/permission-hidden 404 and
      confirm the same conservative behavior.
- [ ] Return a successful delete response without `in_trash: true`; confirm it
      is not accepted as deletion proof.

## Retry and isolation cases

- [ ] Simulate 409, 429, 529, 500, 502, 503, and 504 responses. Confirm bounded
      attempts and total wait.
- [ ] Confirm 429 honors integer and HTTP-date `Retry-After` values.
- [ ] Confirm 401/403 are not retried.
- [ ] Add unrelated page blocks and another synchronized note. Confirm neither
      is modified by a failing note sync.
- [ ] Confirm source note, images, PDF, item fields, collections, and tags are
      unchanged except established unrelated Notero behavior.
- [ ] Inspect logs for tokens, response bodies, note HTML, image bytes/base64,
      and complete local paths.

## Result record

| Area                              | Result  | Evidence / notes |
| --------------------------------- | ------- | ---------------- |
| Zotero 10 multipart realm smoke   | Not run |                  |
| First and unchanged sync          | Not run |                  |
| Image add/delete/replace/reorder  | Not run |                  |
| Feature off/on                    | Not run |                  |
| Ownership attacks and legacy data | Not run |                  |
| Canonical-container isolation     | Not run |                  |
| Crash recovery stages             | Not run |                  |
| Provisional upload recovery       | Not run |                  |
| 404/delete uncertainty            | Not run |                  |
| Retry policy                      | Not run |                  |
| Resource limits                   | Not run |                  |
| Source/content/log preservation   | Not run |                  |
