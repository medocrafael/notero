# Embedded Note Image Sync Manual Validation

## Safety prerequisites

- [ ] Create a dedicated Zotero development profile. Do not open a production
      profile during this validation.
- [ ] Create a synthetic Zotero library or collection with no private papers or
      notes.
- [ ] Create a separate Notion test workspace/database and authorize a
      test-only Notero connection.
- [ ] Confirm that no production token, database ID, item key, or local path is
      present in logs or fixtures.
- [ ] Install only the single release-candidate XPI produced after automated
      verification. Do not install an intermediate build.

## Synthetic source note

Create a regular Zotero item with a child note containing, in order:

1. a heading;
2. a normal paragraph with bold, italic, and linked text;
3. a list;
4. an equation;
5. text before a PDF area-annotation image;
6. text between two PDF area-annotation images;
7. a pasted PNG or JPEG image;
8. text after the final image.

Use only synthetic image content. Confirm that every image is a standard Zotero
embedded-image attachment owned by the child note.

## Validation cases

Record pass/fail evidence for every case. All cases are currently **not run**.

- [ ] With **Sync images embedded in Zotero notes** off, synchronize the note.
      Confirm that text matches previous behavior and no File Upload request is
      made.
- [ ] Enable the image preference and perform the first sync. Confirm text,
      formatting, equations, links, lists, quotes, and all image blocks remain
      in source order.
- [ ] Immediately sync again. Confirm there is one note block, one block per
      source image, and no new File Upload request.
- [ ] Change text only. Confirm the replacement is correct and upload IDs are
      reused.
- [ ] Add an image, delete an image, replace bytes under one image attachment,
      and reorder images in separate runs. Confirm each final result.
- [ ] Disable image sync, edit text, and synchronize. Confirm no image file is
      read or uploaded and legacy text behavior remains.
- [ ] Re-enable image sync and confirm a complete image-bearing replacement.
- [ ] Interrupt the network during upload. Confirm the previous valid note and
      mapping remain active.
- [ ] Interrupt the network during a block append. Confirm the candidate is
      discarded as a whole and content is not blindly appended twice.
- [ ] Revoke access in the test connection to produce 401/403. Confirm the old
      valid note remains and the error is actionable.
- [ ] Simulate or mock 409, 429, 529, 500, 503, and 504 responses. Confirm retry
      counts are bounded.
- [ ] Force old-block deletion failure. Confirm the candidate is rolled back and
      the old mapping remains formal.
- [ ] Force candidate cleanup failure. Confirm orphan recovery metadata is
      recorded and the next sync performs bounded cleanup before new work.
- [ ] Trigger manual and automatic synchronization of the same note together.
      Confirm the final active block is the latest source version.
- [ ] Move an existing note block within the Notero-managed container, then
      resync. Confirm the effective parent is respected.
- [ ] Add user blocks outside `Zotero Notes` and another synchronized child
      note. Confirm neither is modified.
- [ ] Confirm the source note, embedded attachments, PDF, bibliographic item,
      collection membership, and tags are unchanged except for established
      unrelated Notero behavior.
- [ ] Inspect logs and confirm there are no tokens, response bodies, note HTML,
      image bytes/base64, or complete local paths.

## Result record

| Case                             | Result  | Evidence / notes |
| -------------------------------- | ------- | ---------------- |
| First sync                       | Not run |                  |
| Unchanged sync                   | Not run |                  |
| Text-only edit                   | Not run |                  |
| Image add/delete/replace/reorder | Not run |                  |
| Preference off/on                | Not run |                  |
| Upload interruption              | Not run |                  |
| Append interruption              | Not run |                  |
| Authorization failure            | Not run |                  |
| Rate/transient errors            | Not run |                  |
| Rollback and orphan recovery     | Not run |                  |
| Concurrent sync                  | Not run |                  |
| Content/source preservation      | Not run |                  |
| Log redaction                    | Not run |                  |
