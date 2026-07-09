# Pre-beta Final Follow-up Notes

Date: 2026-07-10

Scope: rc.18 release leftovers before the first public beta prerelease.

## 1. Release Workflow Hardening

- `.github/workflows/release.yml` `verify-version` still checks the five package
  versions, and now also checks `packages/core/src/index.ts` `VERSION`.
- The same job now validates `bun.lock` workspace entries for core, tui, cdp, and
  desktop against the tag version, and fails if a scoped CodeShell package spec in
  the lockfile contains a stale semver version.
- `release` now depends on both `package` and `npm-publish`, so a failed npm publish
  blocks GitHub Release creation. Static dependency check passed with no cycle:
  `release -> [package, npm-publish]`, `package -> verify-version`,
  `npm-publish -> verify-version`.
- `packages/desktop/scripts/after-pack-adhoc-sign.cjs` still warns and continues for
  local mac builds, but throws in CI (`CI` or `GITHUB_ACTIONS`) when codesign or
  verification fails.

## 2. Security Regression Tests

- `input-attachments.test.ts`: added a staged attachment symlink case where the file
  under `.code-shell/attachments/<sid>/` points outside the workspace. The test
  asserts the realpath policy blocks it and no image bytes are loaded.
- `engine-structured-image-vision-gate.test.ts`: added a non-vision model case with
  only a structured text/file attachment. The test asserts the LLM is called, no image
  block is sent, no image-error text appears, and file metadata reaches the model.
- `model-facade-recorder-redaction.test.ts`: added non-streaming
  `callWithoutStreaming` coverage next to the existing streaming path. Both assert the
  provider receives plaintext tool_result content while the recorder sees only the
  redaction placeholder.
- Implementation note: the new file-attachment Engine test exposed that non-image
  structured attachment metadata was appended to `parsedTask.text` but then dropped
  because `taskText` fell back to the raw task whenever `parsedTask.hasImages` was
  false. `Engine.run` now uses `parsedTask.text`, which is identical to the raw task
  when there are no inline image blocks and no structured text attachments.

## 3. Checklist Corrections

- `docs/release-checklist-beta.md` now records the actual core publish files:
  `["dist","THIRD_PARTY_NOTICES.md"]`.
- The beta release action path now points to explicit `0.7.0-beta.1` for the public
  beta after `0.6.0-rc.18`, and warns not to use `0.6.0-beta.1` because it sorts below
  the rc line. `--bump rc` remains the same-line rc increment path; beta line jumps
  should use explicit `X.Y.0-beta.N`.

## Verification

- `bun test packages/core/src/engine/input-attachments.test.ts packages/core/src/engine/engine-structured-image-vision-gate.test.ts packages/core/src/engine/model-facade-recorder-redaction.test.ts`:
  15 pass, 0 fail.
- `bun test`: 5217 pass, 6 skip, 0 fail.
- `bun run typecheck`: pass.
- `bun run --filter '@cjhyy/code-shell-desktop' typecheck`: pass.
