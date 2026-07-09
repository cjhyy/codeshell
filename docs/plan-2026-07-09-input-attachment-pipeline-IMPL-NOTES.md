# Input Attachment Pipeline Implementation Notes

Date: 2026-07-09

This file records the implementation status for
`docs/plan-2026-07-09-input-attachment-pipeline.md`. The plan document itself was not edited.

## Stage status

- Stage 1: Done. Desktop main-process attachment service stages image data URLs under
  `<cwd>/.code-shell/attachments/<sessionId>/`, writes `.code-shell/.gitignore`, records metadata
  in a manifest, dedupes by SHA-256, and enforces MIME/session/path safety.
- Stage 2: Done. Renderer paste/drop/file-panel images are staged before send. Staging failure
  blocks sending and surfaces an attachment error. Wire XML remains backward compatible and now
  carries path/hash/size/origin/session metadata when available.
- Stage 3: Done. Core parsing accepts metadata attributes on `<codeshell-image>`. Image path
  collection prefers staged paths and does not fall back to ambiguous names when an explicit path
  is missing.
- Stage 4: Done. `Read` returns metadata and `view_image` guidance for images/binary files instead
  of dumping bytes. `view_image` accepts the planned optional `detail` parameter.
- Stage 5: Done. Added structured `RunParams.attachments`, forwarded through protocol/session/server
  into `Engine.run`, and resolved in core with realpath containment checks. Images become vision
  image parts; files and dirs become bounded textual attachment context.
- Stage 6: Done. File search returns file and directory hits. `@file`, `@dir`, and recent staged
  attachments can be inserted from the desktop mention popover and are sent as structured
  attachments.
- Stage 7: Done. `DriveAgent` accepts `attachmentPaths`, validates them inside `cwd`, adds path
  context to the driven prompt, and passes image paths to Codex with `-i` only when CLI help
  detection confirms support. Detection failure falls back to path-only. Claude remains path-only.
- Stage 8: Done. Attachments are marked sent on submit, draft/sent TTL cleanup is best-effort on app
  startup, session deletion cleans its attachment directory, and cleanup only removes manifest
  entries whose realpath remains inside the attachment root.

## Notable implementation details

- Draft TTL is 24 hours and sent TTL is 30 days, as constants in the desktop attachment service.
- The attachment root is `<cwd>/.code-shell/attachments/<sessionId>/`; no user root `.gitignore` is
  edited.
- No-repo attachment reads are narrowly allowed under `~/.code-shell/no-repo/.code-shell/attachments`
  while other `.code-shell` sensitive paths remain protected.
- Normal desktop sends use structured `RunParams.attachments`; queued/force steer paths still keep
  legacy XML because the steer path does not carry structured run params.
- The renderer continues to avoid runtime imports from codeshell packages; shared attachment shapes
  are structural/type-only at the renderer boundary.
- `packages/core/src/index.ts` was also synchronized from `0.6.0-rc.15` to `0.6.0-rc.17` to match
  `packages/core/package.json`; this fixed an unrelated failing version test needed for full
  `bun test` green.

## Validation

- `bun test packages/desktop/src/main/attachment-service.test.ts packages/desktop/src/renderer/chat/attachments.test.ts tests/parse-task.test.ts packages/core/src/engine/image-policy.test.ts`
  - Passed: 62 pass, 0 fail.
- `bun test packages/core/src/tool-system/builtin/read.test.ts packages/core/src/tool-system/builtin/view-image.test.ts packages/core/src/engine/input-attachments.test.ts tests/chat-session-queue.test.ts`
  - Passed: 27 pass, 0 fail.
- `bun test packages/desktop/src/main/file-search-service.test.ts packages/core/src/cc-orchestrator/agent-adapter.test.ts packages/core/src/cc-orchestrator/external-agent-driver.test.ts`
  - Passed: 23 pass, 3 skip, 0 fail.
- `bun test packages/core/src/tool-system/builtin/drive-claude-code.test.ts tests/path-policy.test.ts`
  - Passed: 49 pass, 0 fail.
- `bun test packages/core/src/tool-system/validate-tool-metadata.test.ts packages/core/src/tool-system/builtin/drive-claude-code.test.ts tests/path-policy.test.ts`
  - Passed: 55 pass, 0 fail.
- `bun run typecheck`
  - Passed: `tsc --noEmit`, exit 0.
- `bun test`
  - Passed: 5136 pass, 6 skip, 0 fail, 11909 expect calls, 5142 tests across 742 files.
- Import/diff hygiene:
  - `rg -n "@cjhyy/code-shell-tui" packages/core || true` found only the existing forbidden-import
    test fixture string.
  - `rg -n "from [\"']@cjhyy/code-shell|require\\([\"']@cjhyy/code-shell" packages/desktop/src/renderer || true`
    found only type-only imports.
  - `git diff --check` passed.
- `bun test`
  - Passed: 5127 pass, 6 skip, 0 fail, 11882 expect calls, 5133 tests across 742 files.

## Residual notes

- Full test output includes recoverable stderr from locally installed plugin hooks in the test
  environment; those hooks did not fail the test run.
- There is no settings UI for attachment TTLs, by decision.

## Review fixes (24 review)

- B-1: Hardened desktop attachment paths against symlink escape. The main attachment service now
  lstat-rejects symlinks for `.code-shell`, the attachments root, session directories, manifest
  files, and existing deduped files; `safeJoin` realpaths existing final targets and re-checks
  containment before reuse; cleanup/list paths reject symlinked manifest/file targets instead of
  following them. Added tests for symlink attachments root, symlink session directory, and symlink
  existing attachment file.
- M-1 / M-4: `RunParams.attachments` now stats first, applies the shared path-policy classifier,
  then runs image byte-size policy before any image `readFile`. The image policy exposes a byte-size
  helper so structured attachment reads reuse the same limits as legacy base64 images. Engine
  capabilities are checked before structured attachment resolution; non-vision models receive only
  path/metadata text for structured image attachments and do not read image bytes.
- M-3: Added a main-process decoded image cap (`MAX_STAGED_IMAGE_BYTES`, 10 MB) before data URL
  decode, with a clear decoded-size-limit error. Added a test that bypasses renderer validation and
  verifies main rejects an oversized data URL.
- M-2: Queued input state now carries structured `attachments` and optional `displayText`. ChatView
  passes engine text plus `{ attachments, displayText }` for busy queue and force-send paths. App
  forwards queued attachments on normal send/relay drain, uses `displayText` for previews/user
  bubbles, and refuses to step-steer queued items with structured attachments because the steer RPC
  only carries text; those items remain queued and are sent as the next run with a toast explaining
  the deferred send. Added queued-input tests for display text, structured attachments, image-only
  queued drafts, and the non-steerable attachment guard.
- Version note: `packages/core/src/index.ts` still has `VERSION` synchronized to `0.6.0-rc.17`.
  Keep it, but split it into a separate `chore(core): sync VERSION to rc.17` commit; do not mix it
  into the input-attachment feature/fix commit.

Review-fix validation so far:

- `bun test packages/desktop/src/main/attachment-service.test.ts packages/core/src/engine/input-attachments.test.ts packages/core/src/engine/image-policy.test.ts packages/desktop/src/renderer/queuedInput.test.ts`
  - Passed: 54 pass, 0 fail.
- `bun run typecheck`
  - Passed: `tsc --noEmit`, exit 0.
