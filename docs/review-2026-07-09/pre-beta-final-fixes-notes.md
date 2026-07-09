# Pre-beta final fixes notes

Date: 2026-07-09

## B1 UseCredential recorder redaction

- Added recorder-only sensitive `tool_result` redaction to `sanitizeMessages`.
- `TurnLoop` now snapshots `sensitiveToolResultRedactions` into
  `ModelFacade` call options while keeping the original model-facing messages
  unchanged for the provider.
- `ModelFacade` records `sanitizeMessages(messages, recordingOptions)` before
  calling the provider; the provider still receives plaintext exactly once.
- Tests:
  - `tests/sanitize-messages.test.ts`
  - `packages/core/src/engine/turn-loop-sensitive-result.test.ts`
  - `packages/core/src/engine/model-facade-recorder-redaction.test.ts`

## B2 Structured image attachment vision gate

- `Engine` now treats `attachmentContext.hasStructuredImageAttachments` as image
  input even when bytes were intentionally not read for a non-vision model.
- Non-vision model + structured image attachment returns `reason: "image_error"`
  before any LLM call.
- Legacy `<codeshell-image>` images and structured attachment images are merged
  instead of structured attachments replacing legacy images.
- Tests:
  - `packages/core/src/engine/input-attachments.test.ts`
  - `packages/core/src/engine/engine-structured-image-vision-gate.test.ts`

## B3 Desktop third-party notices

- Added `packages/desktop/THIRD_PARTY_NOTICES.md` covering:
  - OpenAI Codex apply-patch, Apache-2.0
  - Yoga, MIT
  - browser-use, MIT
- Added the notice file to electron-builder `extraResources` as
  `THIRD_PARTY_NOTICES.md`.
- Test:
  - `packages/desktop/src/main/third-party-notices.test.ts`

## Security M1 Attachment session binding

- `buildInputAttachmentContext` now requires `expectedSessionId` when
  attachments are present.
- Attachment metadata with `attachment.sessionId !== expectedSessionId` is
  rejected before stat/read.
- Staged attachment realpaths are required to stay under
  `.code-shell/attachments/<expectedSessionId>/`.
- `Engine` passes the current run `options.sessionId` into attachment context
  construction.
- Tests:
  - `packages/core/src/engine/input-attachments.test.ts`

## Security M2 Credential migration idempotence

- Migration now reads raw `credentials.json` instead of decrypted
  `CredentialStore.list()` output.
- Already-target `enc:safeStorage:*` entries are not rewritten.
- Legacy bare/plain secrets are rewritten through the active cipher.
- Foreign/unreadable encrypted secrets are left untouched.
- Migration writes each credentials file once per run and serializes work by
  credentials file path with an in-process Promise queue.
- Credential snapshots no longer trigger migration as a side effect.
- Tests:
  - `packages/desktop/src/main/credential-migration.test.ts`
  - `packages/desktop/src/main/credential-access-service.test.ts`

## Verification

- Targeted B1 tests: passed.
- Targeted B2/M1 tests: passed.
- Targeted B3 test: passed.
- Targeted M2 tests: passed.
- `bun test`: 5214 pass, 6 skip, 0 fail.
- `bun run typecheck`: passed.
- `bun run --filter '@cjhyy/code-shell-desktop' typecheck`: passed.
- `bun run lint`: passed with existing warnings, 0 errors.
- `git diff --check`: passed.
