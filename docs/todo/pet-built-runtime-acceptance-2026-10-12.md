# Pet compiled Desktop runtime acceptance

The local macOS acceptance passed the newly built Desktop Main, production
preload/renderer, actual stdio worker and Pet capability on source
`4083718c3e77cc6e629703231d071e646821301d` (0.9.34). The task adds a reusable
acceptance fixture and evidence; no production runtime change was necessary.
The [frozen receipt](pet-built-runtime-acceptance-2026-10-12.json) records the
compiled artifact hashes, actual process IDs, native storage observations and
the remaining acceptance boundaries.

## Scope exercised

- Two Pet inputs use the same durable Session, and the second local model request
  includes the first user input. The real worker exposes `DelegateWork` and the
  Pet manager catalog; execution and MCP tools are excluded from manager turns.
- A registered synthetic project runs two normal Work inputs in the same Session
  through the production renderer IPC. The second request retains the first
  input. This verifies explicit Work continuation; it does not simulate automatic
  Pet delegation or completion-triggered continuation.
- An approved, installed synthetic plugin pinned to version `1.0.0` starts a real
  MCP process, initializes and discovers tools. It has a direct local Node entry,
  an isolated HOME and HTTP-denial probes. No MCP tool is called. This proves the
  installed-plugin loading path; it does not certify the operator's plugins.
- A different Electron Main and actual worker reopen the same private HOME and
  userData. A third Pet input recovers both prior inputs in the same Session and
  the synthetic Pet memory survives the cold restart.
- Main uses actual native `safeStorage` availability, encryption and decryption.
  Instrumentation records method entry/return only and calls the unchanged native
  methods. The effective app name is `code-shell`, Playwright's mock Keychain is
  disabled and `password-store=basic` is absent. No key or plaintext is returned
  by the instrumentation. The existing macOS default-Keychain metadata is checked
  before binding and again after both Electron processes exit.

The only picker replacement returns the fixture's own project directory through
the normal `projectRegistry.createFromPicker` IPC. Main, preload, AgentBridge,
worker, Pet, plugin discovery, Session storage and native cryptography are real.
The provider is a local scripted HTTP server, so this does not evaluate model
quality or paid-provider behavior.

## Verification

`bun install --frozen-lockfile`, the full workspace `bun run build` and the
separate Desktop build passed. The Desktop build's generated Chrome extension
file was restored; it is unrelated to this delivery. Built Server artifacts were
then left stable for the parallel Panel acceptance.

The focused guarded shard passed **65 tests, 310 assertions, zero failures** across
seven files: GitHub Panel source/ref bounds, management/update HTTP behavior,
Desktop update feedback and actual compiled capability-worker lifetime cleanup.
`bun run test:mimi-chat` passed **1,213 tests, 4,077 assertions, zero failures**
across 126 files, including Engine replay, bound IM Session continuation, long
turns, Pet lifecycle and WeChat fixtures. These local fixtures do not prove
external IM delivery.

The runtime smoke, Node syntax check, targeted ESLint, Prettier and
`git diff --check` passed. The smoke also requires zero captured renderer errors.

## Reproduction

Finish workspace and Desktop builds before the smoke. Never run
`test:package-release` concurrently with a reader of package `dist/`; that command
cleans build outputs. On macOS, create a fresh private metadata directory and
capture only the already configured default-Keychain path and file identity in
the ordinary OS session. This command reads no Keychain item or password.

```sh
task_keychain_dir=$(mktemp -d /tmp/codeshell-pet-keychain-ref.XXXXXX)
node packages/desktop/scripts/macos-keychain-context.mjs --capture "$task_keychain_dir/reference.json"
bun run --cwd packages/desktop test:e2e:pet-runtime --default-keychain-reference "$task_keychain_dir/reference.json" --receipt "$task_keychain_dir/runtime-receipt.json"
```

Use a new receipt path for each run. See [native Keychain acceptance](macos-keychain-acceptance.md)
for the existing metadata-only private-HOME binding. The fixture never copies
Keychain data, unlocks a Keychain, changes the OS default, or handles authorization
dialogs. Linux uses the existing private SecretService wrapper; this task's new
Pet runtime scenario was executed only on macOS.

Main and each actual spawned worker install the exact-origin fetch/http/https
guard before Core imports. Worker stdin remains corked until PID/PPID and private
HOME receipts are verified. The synthetic plugin denies HTTP separately. This
is JavaScript transport instrumentation, with no Chromium, raw net/tls or OS
confinement claim. The smoke inspects only its synthetic profile on failure and
cleans up its owned Electron processes and temporary profile.

## Preserved fixture failures

Early attempts did not pass and are not counted as product acceptance:

1. A private HOME without default-Keychain metadata blocked native storage.
   The fixture was corrected to reuse the existing metadata-only binding; native
   cryptography was never mocked or bypassed.
2. A trust entry alone did not register a project, so Work creation was correctly
   rejected. The fixture now uses the production folder-picker registration IPC.
3. The first cold-restart assertion included previous-generation child receipts.
   Each generation now verifies its own receipts before resetting those files.
4. The visible Add Project locator was absent in one renderer state. Project
   registration now invokes the public picker IPC directly, removing that
   incidental sidebar dependency from this runtime smoke.

No production defect was inferred from these failed fixture attempts.

## Remaining deployment acceptance

Real WeChat account delivery, real long-running IM turns, the operator's actual
plugin configuration and its pinned/preinstalled release entry, automatic Pet
Work delegation/continuation in that environment, and a packaged/signed installed
application remain unverified. No real account write, external message, original
Session edit, global plugin update or paid model request was performed. The root
TODO retains these remaining tasks.

## Panel update status

The old clean `panel-update-feedback` head `eafb6def` is already included through
merge `4f91f3b6` (#124). The old dirty `panel-update-local-runtime` worktree's
GitHub ref/request/archive, Desktop UI and Server management implementations are
already present in this source. Its extra Core exports differ because main has
newer unrelated features. No old worktree or uncommitted file was modified,
copied wholesale or removed. The focused 65-test shard verifies the current Host
behavior. Panel business delivery remains in its separate repository.
