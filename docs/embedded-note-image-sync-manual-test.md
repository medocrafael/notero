# Embedded Note Image Sync — Isolated Manual Validation Checklist

## Current status

Manual end-to-end validation has **not** been run in this implementation round.
No XPI was generated, no plugin was installed, and no production Zotero or
Notion data was accessed. This checklist is a later gate after independent code
review and explicit authorization to produce an isolated test artifact.

Zotero runtime status is reported in two separate evidence classes. A
previously supplied Zotero 9.0.6 primitive transaction spike is `PASS`; it did
not execute the current production adapter/store. The production adapter/store
smoke below is **PENDING USER RUN**. Zotero 10.x runtime validation and all
plugin E2E remain pending.

## Reproduction gate: Zotero 9.0.6 runtime adapter smoke

Before any image-sync or Notion test, run
`scripts/zotero-9-runtime-adapter-smoke.ts` in a disposable Zotero 9.0.6
development profile. Do not run it in a normal profile. The script creates only
objects whose titles begin with `SAFE TO DELETE`, does not call Notion, does not
read SQLite, and emits one structured JSON PASS/FAIL result.

Prepare the console bundle from the reviewed source SHA without executing it:

```powershell
pnpm exec esbuild scripts/zotero-9-runtime-adapter-smoke.ts --bundle --format=iife --platform=browser --target=firefox115 --outfile=tmp/notero-zotero9-runtime-smoke.js
```

In Zotero's developer “Run JavaScript” window, load the reviewed bundle and
invoke `await globalThis.runNoteroZotero9RuntimeSmoke()`. Record the complete
structured result, Zotero version, source SHA, and IDs of the synthetic objects.
Delete those marked objects only after the result has been reviewed.

The smoke must report PASS for:

- receiver-bound `DB.executeTransaction`;
- receiver-bound `DB.inTransaction`;
- receiver-bound `Items.reload`;
- production metadata load;
- transaction-local reload, revision compare, immutable merge, and `save()`;
- production `setNote()`/`save()` metadata persistence;
- stale-root writer rejection;
- fresh-adapter reload of the committed root/note revisions.

Any FAIL blocks further manual testing and push authorization. Do not report
the prior primitive spike as this smoke's result: they exercise different code.
The repository production-adapter smoke has not been run in this implementation
round and remains `PENDING USER RUN` until its structured result is returned.

## Isolation prerequisites

Do not begin unless all of the following are true:

- a disposable Zotero development profile exists and is visibly distinct from
  the normal profile;
- the profile contains only synthetic test items and images;
- Zotero sync is disabled for the development profile;
- a separate Notion test database and test-only integration/connection exist;
- no production token, database ID, page ID, library ID, item key, note text,
  PDF, or image is present;
- the artifact SHA and source commit are recorded;
- logs are configured to avoid tokens, file bytes, full local paths, and note
  contents;
- the Draft PR has passed independent read-only review;
- no public relay, tunnel, or image host is running.

This initial RC gate is Zotero 9 only. A later Zotero 10 gate must use a
different disposable profile and must pass before the manifest can be widened.

## Synthetic source note

Create one synthetic parent item with a child note containing, in order:

1. a heading;
2. a paragraph before the first image;
3. bold and italic text;
4. a harmless synthetic link;
5. a list and quote;
6. an equation if current text sync supports it;
7. PDF area-annotation image A;
8. text between images;
9. PDF area-annotation image B;
10. a pasted image if Zotero represents it differently;
11. text after the final image.

Use only small synthetic PNG/JPEG/GIF/WebP fixtures. Separately prepare
unsupported/corrupt SVG, APNG, AVIF, BMP, truncated, over-20-MiB, over-32-count,
and over-100-MiB-aggregate cases.

## Functional sequence

For each case, record Zotero version, source commit/artifact hash, preference
state, source change, expected result, observed Notion block order, metadata
state, upload counts where observable, log review, and PASS/FAIL/BLOCKED.

| ID  | Action                                                                             | Required result                                                                                                    |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| M01 | Enable “Sync notes” and opt-in embedded images; run first sync.                    | One managed container and one complete active note; text/images preserve relative order; images are Notion-hosted. |
| M02 | Immediately sync unchanged source.                                                 | No new note/image block, upload, cleanup target, or mapping revision.                                              |
| M03 | Change text only.                                                                  | Old active remains until new candidate verifies and commits; attached image uploads are reused.                    |
| M04 | Add a supported image.                                                             | One new content-identity upload; final order matches Zotero.                                                       |
| M05 | Delete an image occurrence.                                                        | New active omits it; unrelated images and page content remain; old active cleanup is orthogonal.                   |
| M06 | Replace bytes while retaining attachment identity.                                 | New content hash creates one new upload; old content is not mistaken for the replacement.                          |
| M07 | Reorder two images.                                                                | Final block order changes without duplicate upload of unchanged image bytes.                                       |
| M08 | Disable embedded-image sync and edit text.                                         | Zero image resolution/upload/new image metadata; text-only behavior matches prior Notero behavior.                 |
| M09 | Re-enable image sync.                                                              | Images return through a new opt-in source version with correct ordering.                                           |
| M10 | Sync two child notes under one parent.                                             | Notes share one managed container but have independent records/active blocks/cleanup.                              |
| M11 | Add user blocks before/after the managed container and between other page content. | User-created content remains byte/position-equivalent and is never deleted or updated.                             |
| M12 | Seed formal-main bare legacy IDs.                                                  | New managed v4 copies are created once; legacy blocks remain untouched and are not adopted.                        |

## Failure and restart sequence

Use the test connection, a controlled proxy, or deterministic development
failpoint. Never induce failures against production.

| ID  | Failure                                                            | Required result                                                                                            |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| F01 | Stop the process after durable intent but before remote request.   | Restart observes/proves the intent state; no blind mutation replay; old active remains.                    |
| F02 | Lose response after remote create/append commit.                   | Exact marker/content reconciliation converges or seals quarantine; no duplicate create/append.             |
| F03 | Stop after response delivery but before local observation persist. | Fresh process/session reloads v4 JSON and observes the durable intent; old active remains until commit.    |
| F04 | Fail local metadata persist before remote execution.               | Remote mutation count is zero and the prior durable root/active remains valid.                             |
| F05 | Interrupt one upload among multiple images.                        | No partial candidate becomes active; exact upload lifecycle evidence remains; no automatic infinite retry. |
| F06 | Return 401, then repair credentials.                               | One same-run attempt, actionable halt, sealed evidence; a later invocation may resume.                     |
| F07 | Return 403, then restore capability.                               | Same as F06; no resource mutation while permission is absent.                                              |
| F08 | Return 409/429/500/503/504 and timeout variants.                   | Repository retry policy is bounded; `Retry-After` and deadlines use the injected/runtime clock.            |
| F09 | Move the current active block.                                     | Liveness detects mismatch; moved block is neither updated nor deleted.                                     |
| F10 | Edit the active ownership marker or title.                         | Pre-write ownership fails closed; edited block remains untouched.                                          |
| F11 | Trash the active block externally.                                 | Liveness detects stale mapping and creates only a new managed candidate under policy.                      |
| F12 | Return 404 for cleanup target.                                     | Cleanup becomes uncertain, never confirmed; later source generations still commit.                         |
| F13 | Return `archived=true`, `in_trash=false`.                          | No delete confirmation and no destructive retry without new exact evidence.                                |
| F14 | Interrupt child pagination or return a missing cursor.             | Candidate verification fails closed; previous active remains authoritative.                                |
| F15 | Create duplicate exact operation markers.                          | Reconciliation seals ambiguity/quarantine and never adopts or deletes either block.                        |
| F16 | Advance beyond liveness TTL.                                       | The next invocation performs one liveness cycle and returns stable; no liveness loop.                      |
| F17 | Change workspace/database/page target identity.                    | No old target mapping is adopted or mutated; operation fails closed before remote write.                   |

## Unsupported and limit cases

- PNG, JPEG, GIF, and WebP valid fixtures succeed.
- SVG, APNG, AVIF, and BMP fail before upload.
- corrupt/truncated or MIME-mismatched bytes fail before upload.
- one file over 20 MiB fails before upload.
- more than 32 image occurrences fails before upload.
- aggregate image bytes over 100 MiB fails before upload.
- a missing, unreadable, wrong-library, wrong-parent, or non-image attachment
  fails without changing the source note, PDF, images, active mapping, or page.

## Source and privacy verification

After every successful and failed case, verify:

- Zotero note HTML, image attachments, source PDF, bibliography, collections,
  tags, and user attachments are unchanged;
- only the hidden Notero metadata linked-URL attachment changed as expected;
- only the exact Notero-managed candidate/cleanup block was mutated;
- unrelated Notion page/database content and other synchronized notes are
  unchanged;
- no external image URL/relay was used;
- logs contain no token, file bytes/base64, full private path, private note
  content, or real library/item identity.

## Result record

| Environment                                 | Status                | Notes                                                                    |
| ------------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| Zotero 9.0.6 primitive transaction spike    | PASS (supplied prior) | Baseline primitives only; not current production adapter/store evidence. |
| Zotero 9.0.6 production adapter/store smoke | PENDING USER RUN      | Must run the reviewed script in a disposable profile and return JSON.    |
| Zotero 9.x plugin E2E                       | NOT RUN               | Requires a later reviewed isolated artifact; no XPI currently exists.    |
| Zotero 10.x runtime/plugin E2E              | NOT RUN / OUTSIDE RC  | Code contract only; manifest remains intentionally scoped to Zotero 9.   |
| Separate Notion test database E2E           | NOT RUN               | No live Notion connection used in this round.                            |
| Production Zotero/Notion                    | PROHIBITED / NOT RUN  | Outside the safety boundary.                                             |

Any failed safety condition blocks installation and release. Preserve the
exact artifact, logs with secrets redacted, and synthetic reproduction data for
independent review; do not retry against production.
