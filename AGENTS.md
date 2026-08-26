# AGENTS.md

## Project: Safe synchronization of embedded Zotero note images to Notion

This file is local project guidance for Codex and other coding agents working in this repository.

**Do not modify this file. Do not include it in an upstream pull request unless the user explicitly asks you to do so.**

---

## 1. Mission

Extend Notero so that images embedded inside Zotero child notes are synchronized to the corresponding Notion page together with the existing note text.

The completed workflow must support:

```text
Zotero PDF
  → LLM for Zotero or the Zotero note editor creates a child note
  → the child note contains text, formatting, equations, links, and embedded images
  → Notero synchronizes the note
  → the corresponding Notion page contains the same note content
  → text and images remain in their original relative order
```

The feature must be suitable for a real research library. A merely demonstrable patch is not acceptable.

---

## 2. Product outcome

When the feature is enabled, a Zotero child note such as:

```text
Heading

Paragraph before the image.

[embedded Zotero image or PDF area annotation]

Paragraph after the image.

[second embedded image]
```

must appear in the existing `Zotero Notes` area of the matching Notion page as:

```text
Heading

Paragraph before the image.

[Notion-hosted image block]

Paragraph after the image.

[Notion-hosted image block]
```

The source image bytes must be read locally from Zotero and uploaded directly to Notion through the official Notion File Upload API. Do not use a public image host, temporary external URL, Cloudflare tunnel, ngrok, or any third-party media relay.

---

## 3. Non-negotiable safety requirements

### 3.1 No production experimentation

Do not:

- connect automated tests to the user's production Notion workspace;
- use the user's real literature database for initial testing;
- install an intermediate `.xpi` into the user's normal Zotero profile;
- publish a GitHub release;
- merge into `main`;
- push directly to the upstream Notero repository;
- create or update a production Notion page from a cloud development environment;
- expose local Zotero files through a public URL.

Development must use mocks, fixtures, a dedicated Zotero development profile, and a separate Notion test database.

### 3.2 Preserve Zotero source data

The implementation may read:

- note HTML;
- embedded-image metadata;
- Zotero attachment/image items;
- image file bytes;
- existing Notero-owned synchronization metadata.

It must not modify:

- the source PDF;
- note content;
- note images;
- bibliographic metadata;
- collections;
- tags, except existing Notero behavior that is unrelated to this feature;
- user-created attachments;
- any other user content.

Extending Notero's own hidden synchronization metadata is permitted only when necessary and backward compatible.

### 3.3 Preserve existing Notion content

The feature must modify only the Notero-managed note block for the Zotero child note being synchronized.

It must not modify or delete:

- content elsewhere on the Notion page;
- user-created blocks outside Notero's managed `Zotero Notes` container;
- other synchronized Zotero notes;
- database properties unrelated to the existing item sync;
- the last known-good version of a synchronized note before a complete replacement is ready.

### 3.4 Never leave a partially replaced note

The current implementation deletes the existing note block before creating and populating its replacement. That behavior is not safe enough for media synchronization.

For an existing note, the new implementation must follow equivalent transactional semantics:

1. Keep the current valid Notion note block intact.
2. Resolve and validate all required local images.
3. Create and upload required Notion file uploads.
4. Create a replacement note block in a staging state.
5. Append all text and image blocks successfully.
6. Confirm that all append operations completed.
7. Persist the new synchronization mapping.
8. Only then remove the previous note block.
9. If any operation before completion fails:
   - remove any temporary block created by this attempt where safe;
   - do not replace the saved mapping with an incomplete mapping;
   - keep the old valid note block;
   - return a clear error;
   - do not enter an automatic infinite retry loop.

The exact staging strategy may differ if the repository architecture supports a safer approach, but the externally observable guarantees above are mandatory.

For a first-time note sync, a failure must not leave a note block that appears complete while missing content. Clean up incomplete temporary blocks where possible.

### 3.5 Idempotency

Repeating the same synchronization operation without any source-note change must produce the same visible Notion result and must not:

- create duplicate note blocks;
- create duplicate visible image blocks;
- upload unchanged images again;
- alter user content;
- change the saved mapping unnecessarily.

The design must use stable source identity and content identity. At minimum, consider:

```text
Zotero library identity
+ parent item key
+ note item key
+ embedded image identity
+ image content hash
+ normalized note content hash
```

Do not assume that a bare Zotero item key is globally unique across personal and group libraries.

Codex must verify whether an attached Notion `file_upload` ID can be safely reused for this use case. Do not rely on undocumented behavior. If reuse is unsupported, design an alternative that still prevents duplicate uploads on unchanged synchronizations, such as skipping unchanged notes or retaining unchanged image blocks.

### 3.6 Bounded failure and retry behavior

Handle at least:

- Notion authentication errors;
- authorization/capability errors;
- HTTP 409;
- HTTP 429;
- transient HTTP 5xx errors;
- request timeouts;
- network interruption between file creation, upload, and block attachment;
- missing Zotero image files;
- unreadable or corrupt image files;
- unsupported image MIME types;
- oversized files;
- expired or failed Notion file uploads;
- partial failure after one of multiple images has uploaded;
- stale or corrupt Notero synchronization metadata.

Retries must be bounded and use the repository's existing retry conventions where available. Never implement an unbounded retry loop.

### 3.7 No secret leakage

Never log or commit:

- Notion access tokens;
- OAuth connection tokens;
- complete local file paths unless debug logging explicitly requires them and paths are redacted;
- file bytes or base64 payloads;
- private note text in test snapshots;
- real Zotero library IDs or item keys supplied by the user.

Use synthetic fixtures.

---

## 4. Scope

### 4.1 Required in this project

The release candidate must include:

1. Detection of images embedded in Zotero child-note HTML.
2. Resolution of each supported embedded image to local bytes using supported Zotero APIs.
3. MIME-type and size validation.
4. Upload through the official Notion File Upload API.
5. Creation of Notion image blocks.
6. Preservation of the relative order of text and images.
7. Safe replacement semantics for existing synchronized notes.
8. Idempotent repeated synchronization.
9. Backward compatibility for text-only notes.
10. Explicit user control for the feature.
11. Actionable error reporting.
12. Automated unit and integration tests.
13. A manual end-to-end validation procedure.
14. A single release-candidate `.xpi` produced only after all required checks pass.

### 4.2 Feature control

Add a preference equivalent to:

```text
Sync images embedded in Zotero notes
```

Requirements:

- default: `OFF`;
- when `OFF`, existing text-only behavior remains unchanged;
- when `ON`, supported embedded images are synchronized;
- preference text must be localized using the repository's established localization system;
- no image upload may occur when the preference is off.

If repository maintainers' conventions strongly favor making images part of `Sync notes` without a second toggle, document that finding in the design. For this user's release candidate, the behavior must still remain explicitly opt-in until tested.

### 4.3 Explicitly out of scope

Do not add any of the following in this project:

- synchronization of arbitrary Zotero PDF attachments;
- synchronization of MinerU ZIP packages;
- extraction of `full.md` from ZIP files;
- monitoring external Better Notes Markdown folders;
- arbitrary local Markdown attachment synchronization;
- bidirectional Notion-to-Zotero synchronization;
- Notion Agent or MCP integration;
- a third-party image hosting service;
- OCR;
- image understanding or caption generation;
- broad redesign of Notero's database-property system;
- unrelated issue fixes;
- support for pre-Zotero-10 branches unless the user explicitly expands scope.

Issue #772 about general attachment/PDF synchronization may be referenced for API context, but this project is limited to images already embedded in Zotero child notes.

---

## 5. Repository facts to revalidate at task start

Do not blindly trust this section. Recheck the checked-out branch before editing.

At the time this guidance file was prepared, the upstream `main` branch indicated:

- Vite+ is the primary task runner/toolchain.
- Node.js requirement: `>=24.3.0`.
- package manager: `pnpm@10.33.2`.
- Notion SDK dependency: `@notionhq/client` `^4.0.1`.
- target on `main`: Zotero 10.
- relevant package scripts include:
  - `build`;
  - `check`;
  - `lint`;
  - `fmt:check`;
  - `test`;
  - `typecheck`;
  - `verify`;
  - `create-xpi`.
- current note synchronization entry point:
  - `src/content/sync/sync-note-item.ts`.
- current HTML parsing area:
  - `src/content/sync/html-to-notion/`.
- current parser does not have a dedicated `IMG` node type.
- current note update flow deletes the old note block before creating and filling the new one.
- current flow saves synchronization state before `addNoteBlockContent()` completes.

Treat the checked-out source as authoritative and record any differences in the implementation report.

---

## 6. Upstream context and official APIs

Review these before implementation:

- Notero issue for embedded note figures:
  - https://github.com/dvanoni/notero/issues/385
- Notero issue noting the newer Notion upload capability:
  - https://github.com/dvanoni/notero/issues/772
- Notero repository:
  - https://github.com/dvanoni/notero
- Notion File Upload object:
  - https://developers.notion.com/reference/file-upload
- Create a file upload:
  - https://developers.notion.com/reference/create-file
- Send a file upload:
  - https://developers.notion.com/reference/upload-file
- Notion block model, including image blocks:
  - https://developers.notion.com/reference/block

Use official Notion documentation as the source of truth for upload lifecycle, size limits, supported MIME types, attachment timing, and API version behavior.

Use supported Zotero APIs as the source of truth for note-image resolution. Do not parse the Zotero SQLite database directly and do not invent file paths from item keys.

---

## 7. Required development workflow

Work on a dedicated branch, for example:

```text
feature/sync-embedded-note-images
```

Intermediate commits are allowed inside the feature branch. Intermediate plugin builds must not be installed in the production Zotero profile or published as releases.

### Phase 0 — Baseline

Before modifying code:

1. Record:
   - current branch;
   - current commit SHA;
   - Node version;
   - package-manager/toolchain version;
   - Zotero target version;
   - Notion SDK version.
2. Install dependencies using the repository's documented command.
3. Run the unmodified baseline:
   - formatting check;
   - lint/check;
   - typecheck;
   - full test suite;
   - build.
4. Record all failures before changing code.
5. Do not hide or silently fix unrelated baseline failures.

If the baseline is broken for reasons unrelated to this task, isolate the cause and report it. Do not broaden the feature PR without explicit necessity.

### Phase 1 — Audit and design

Before implementation, inspect and document:

1. The complete call path from a Zotero note-modified event to `syncNoteItem`.
2. The complete call path from `noteItem.getNote()` to Notion block requests.
3. Every image representation produced by Zotero 10 child notes, including images originating from:
   - PDF area annotations;
   - images pasted into notes;
   - images saved by LLM for Zotero, if they are standard Zotero embedded-note images.
4. The supported Zotero API needed to resolve each representation.
5. The existing Notero persistence format for:
   - page IDs;
   - note block IDs;
   - container block IDs;
   - other sync metadata.
6. The current Notion OAuth/integration capabilities and API version.
7. Whether code in this repository alone can use File Upload APIs, or whether the hosted Notero OAuth service/integration configuration must change.
8. Existing Notion API error/retry handling.
9. Existing tests and mocks that can be extended.
10. A safe staging, commit, rollback, and cleanup design.
11. A concrete idempotency design.
12. A migration/backward-compatibility design for existing synced notes.

Write the design to:

```text
docs/embedded-note-image-sync-design.md
```

The design document must cite source files and symbols, not only describe assumptions.

Proceed to implementation if no external blocker exists. If a hosted service, integration-scope change, or destructive data migration is required, stop implementation and report the blocker with evidence.

### Phase 2 — Tests first

Add failing tests for the required behavior before completing the implementation.

Do not weaken existing assertions to make the new code pass.

### Phase 3 — Implementation

Implement the smallest architecture that satisfies every acceptance criterion.

Prefer separation of concerns:

```text
Zotero note HTML parsing
  → embedded image descriptors
  → local image resolver
  → MIME/size validation
  → Notion upload service
  → block conversion
  → safe note replacement coordinator
  → persistence/idempotency metadata
```

Do not put file I/O, network upload, and DOM parsing into one function.

The HTML parser should represent an image explicitly rather than treating `<img>` as rich text.

Image upload is asynchronous. Do not convert unrelated synchronous parsing code into an uncontrolled network-aware parser. A two-stage or intermediate-representation design is preferred:

```text
parse/scan note
  → collect structured content and image references
  → resolve/upload images
  → render Notion blocks with prepared image references
```

A different architecture is acceptable only if it remains testable, deterministic, and safe.

### Phase 4 — Adversarial review

After the first complete implementation, review the diff as if it were untrusted.

Specifically look for:

- old note deletion before replacement success;
- state saved in a `finally` block after failure;
- duplicate upload paths;
- stale mapping behavior;
- file-upload IDs used after expiry;
- unsupported assumptions about reusing uploaded files;
- invisible partial blocks;
- orphaned temporary blocks;
- unbounded retries;
- excessive concurrency;
- Notion rate-limit violations;
- source-data mutation;
- accidental syncing when the feature is disabled;
- changes to unrelated item sync behavior;
- secrets or real data in fixtures;
- a successful unit test suite that does not test actual ordering.

Fix every material finding before producing an RC.

### Phase 5 — Validation and packaging

Run all required repository checks again.

Only after they pass:

1. Build the plugin.
2. Create an `.xpi`.
3. Label it as a release candidate, not a production release.
4. Do not publish it to the upstream update channel.
5. Provide a checksum.
6. Provide the exact commit SHA used for the build.
7. Provide a manual validation checklist.

---

## 8. Functional acceptance criteria

All criteria below are required unless the design proves that a criterion is impossible due to an external platform limitation. In that case, stop and report rather than silently reducing scope.

### 8.1 Basic image sync

- A note with one supported embedded image produces one Notion image block.
- The image displayed in Notion corresponds to the Zotero source image.
- The image is hosted by Notion after upload.
- No public intermediary URL is used.

### 8.2 Ordering

For each case, relative order is preserved:

- text → image → text;
- image → text;
- text → image;
- text → image A → text → image B → text;
- heading → paragraph → image → paragraph;
- image adjacent to a list or quote;
- multiple images in one note.

Exact HTML nesting may be normalized to Notion's block model, but semantic order must remain stable.

### 8.3 Text and formatting regression

Existing supported text behavior must remain intact, including current support for:

- paragraphs;
- headings;
- lists;
- quotes;
- code;
- inline formatting;
- links;
- equations;
- note title;
- batching according to Notion block limits.

### 8.4 Repeat synchronization

Synchronizing an unchanged note twice must:

- leave one visible note block;
- leave one visible block for each source image;
- perform no new upload for unchanged content;
- preserve the same source-to-Notion mapping;
- preserve content elsewhere on the page.

### 8.5 Text-only modification

If only text changes and images do not:

- final Notion text updates;
- each source image appears once;
- unchanged image content is not uploaded again;
- previous valid content remains visible until replacement succeeds.

### 8.6 Image changes

Cover:

- adding an image;
- deleting an image;
- replacing image contents while retaining a source identity;
- reordering images;
- changing an image caption or alt text where supported.

The final Notion note must match the source note after a successful sync.

### 8.7 Multiple notes

Updating one child note must not modify:

- another child note under the same Zotero parent;
- the top-level `Zotero Notes` container;
- user content outside the container.

### 8.8 Feature disabled

With embedded-image synchronization disabled:

- no Notion file upload request occurs;
- text-only sync matches the previous behavior;
- no new image metadata is written.

### 8.9 Safe failure

For every failure injected before completion:

- the previous valid Notion note remains available;
- saved sync metadata does not point to an incomplete block;
- temporary blocks are cleaned up where possible;
- the error identifies the note and failure stage without leaking secrets;
- unrelated sync tasks remain able to proceed.

---

## 9. Required automated test matrix

Use synthetic notes and image fixtures.

### 9.1 Parser tests

Test at least:

- plain `<img>` behavior;
- each actual Zotero 10 embedded-image representation found during audit;
- relevant `data-*` attributes;
- image inside a paragraph or container;
- image between text nodes;
- multiple images;
- malformed image element;
- unsupported source;
- existing non-image parsing unchanged.

### 9.2 Resolver tests

Test at least:

- valid attachment/image lookup;
- personal library identity;
- group library identity;
- missing item;
- wrong item type;
- missing local file;
- unreadable file;
- valid PNG;
- valid JPEG;
- every additional supported source type discovered during audit;
- MIME determined from reliable metadata and/or bytes;
- content hash stability;
- content hash changes when bytes change.

### 9.3 Upload-service tests

Mock the official Notion SDK and test:

- create upload;
- send upload;
- retrieve/status if used;
- attach upload to an image block;
- 401/403;
- 409;
- 429 with bounded retry;
- 500/503/504 with bounded retry;
- timeout;
- upload expiration;
- unsupported MIME;
- size boundary;
- no upload when feature is disabled;
- no second upload for unchanged content.

### 9.4 Note synchronization tests

Test:

- first sync success;
- existing-note replacement success;
- unchanged resync;
- text-only change;
- image addition;
- image deletion;
- image replacement;
- image reorder;
- multiple images;
- one of several uploads fails;
- note block creation fails;
- content append fails in the first batch;
- content append fails in a later batch;
- old block deletion fails after new content is complete;
- temporary cleanup fails;
- saved metadata is stale;
- existing note block was manually moved;
- existing note block was archived or deleted;
- parent item is not synced;
- top-level note is rejected as before;
- user-created page content is untouched.

### 9.5 Backward compatibility tests

- Existing text-only fixtures produce the same block structure unless a deliberate safe-replacement change requires a documented difference.
- Existing saved note metadata still loads.
- Existing users with the preference absent receive the default `OFF`.
- No migration corrupts existing item data.

---

## 10. Manual end-to-end validation

Do not use the user's production profile or database.

Create:

```text
A dedicated Zotero development profile
A small test library or collection
A separate Notion test database
A test-only Notero connection
```

Create a test Zotero parent item with a child note containing:

- a heading;
- normal paragraph text;
- bold and italic text;
- a link;
- a list;
- an equation if currently supported;
- two PDF area-annotation images;
- one pasted image if Zotero represents it differently;
- text before, between, and after images.

Validate:

1. First synchronization.
2. Immediate unchanged synchronization.
3. Text-only edit.
4. Add one image.
5. Delete one image.
6. Replace one image.
7. Reorder images.
8. Disable image synchronization and edit text.
9. Re-enable image synchronization.
10. Interrupt the network during upload.
11. Force an authorization error in the test connection.
12. Force or mock rate limiting if live reproduction is impractical.
13. Confirm unrelated Notion page content remains unchanged.
14. Confirm source Zotero note, images, and PDF remain unchanged.
15. Confirm logs contain no secrets or full private note data.

Record the result of each case.

---

## 11. Code-quality requirements

- Follow the repository's existing TypeScript style.
- Maintain strict typing; do not introduce broad `any`.
- Prefer small, testable functions.
- Do not suppress errors with empty `catch` blocks.
- Do not add `@ts-ignore` without an exceptional, documented reason.
- Do not disable lint rules broadly.
- Do not change dependencies unless necessary.
- If a dependency change is necessary, justify it and prefer existing platform/SDK functionality.
- Do not add a second HTTP client when the official Notion client already supports the required API.
- Avoid reading the whole image into multiple redundant in-memory representations.
- Bound concurrent image uploads.
- Preserve actionable error causes.
- Use conventional commit messages consistent with the repository.
- Keep unrelated formatting changes out of the feature diff.

---

## 12. Required verification commands

Use the current repository documentation and `package.json` as the source of truth. At minimum, the final report must show successful execution of the current equivalents of:

```text
format check
lint/check
typecheck
full unit/integration test suite
production build
XPI packaging
```

At the time this file was prepared, expected commands included:

```bash
vp install
vp check
vp test
vp run build
vp run create-xpi
```

The repository also declared scripts such as `verify`, `fmt:check`, `lint`, and `typecheck`. Use the exact valid commands on the checked-out revision and report them verbatim.

Do not claim a check passed without including its actual command and exit status in the final report.

---

## 13. Deliverables

The completed branch must contain:

1. `docs/embedded-note-image-sync-design.md`
2. production implementation
3. unit and integration tests
4. synthetic image fixtures
5. localized preference text
6. documentation describing:
   - supported image types;
   - size limits;
   - opt-in setting;
   - failure behavior;
   - privacy/data flow;
   - how to test safely
7. a PR-ready description referencing issue #385
8. a test report
9. a manual validation checklist
10. one release-candidate `.xpi`, produced only after all automated checks pass
11. SHA-256 checksum for the `.xpi`
12. exact source commit SHA

Do not create a public release or modify the upstream update manifest.

---

## 14. Final report format

At completion, return a report with these headings:

```text
Summary
Architecture
Files Changed
Safety Guarantees
Idempotency Strategy
Failure and Rollback Behavior
Automated Tests
Manual Test Status
Commands Run
Known Limitations
Artifacts
Commit SHA
Pull Request Status
```

Under `Known Limitations`, distinguish:

- genuine platform limitations;
- deliberately out-of-scope features;
- untested behavior.

Do not describe an unverified assumption as a completed feature.

---

## 15. Stop conditions

Stop implementation and report evidence if any of these is true:

1. The current Notero public OAuth integration lacks a required capability that can only be changed in a separately hosted service or private configuration not present in this repository.
2. Supported Zotero APIs cannot resolve the actual embedded-image representation without direct database manipulation.
3. The official Notion API cannot attach the required supported image type.
4. Safe replacement cannot be implemented without destructive migration of existing user data.
5. Baseline repository failures make test results untrustworthy and cannot be isolated.
6. A required behavior depends on undocumented API behavior that cannot be verified.
7. The repository revision differs materially from the assumptions in this file and changes the project scope.

Do not invent a workaround that weakens data safety. Provide a minimal blocker report with source references and a recommended next action.

---

## 16. Initial Codex instruction

After this file is placed in the repository root, the user may start Codex with:

```text
Read AGENTS.md in full and execute the embedded-note image synchronization project on a new feature branch.

Follow every safety gate. Begin with baseline verification and source audit, write the design document, then continue through implementation, adversarial review, full automated verification, and release-candidate packaging if no external blocker exists.

Do not access production Zotero or Notion data. Do not publish a release or merge to main. Do not stop after producing only a plan unless a stop condition in AGENTS.md is met.
```
