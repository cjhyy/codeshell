# Quick Chat lifecycle independent review — round 8

Snapshot: `a66f4ef291f304ee4df9da8095a90671d9a8f140` (0.9.33). Product tree was read only; no build, real model, account, external request, or microphone was used. Evidence is in this directory. The scoped review found one narrow P3 candidate; the other examined lifecycle paths behaved as designed.

## Q1 — P3: an internal Files Panel image drop is silently discarded by Quick Chat

**Behavior.** A real `FilesPanel` file row creates `application/x-codeshell-path` on drag. When this payload names a PNG, the real `QuickChatPanel`/`ChatView` target accepts the drop but creates neither an image chip nor a path reference, issues no image staging request, and displays no error. The same real source row's PDF payload creates a path chip and sends successfully. An OS-style PNG drop into the same Quick Chat stages and attaches successfully.

**Root cause.** `ChatView.tsx:1454–1462` gives the internal custom-MIME payload priority, calls `onAttachImagePath?.(draggedPath)` for an image, and returns. `QuickChatPanel.tsx:139–178` does not supply that optional callback. The normal main composer supplies it from `App.tsx:2529`; its `attachImageByPath` function at `App.tsx:399–422` reads the image and records path metadata. The source producer is the implemented draggable file row at `FilesPanel.tsx:593–601`, enabled by the ordinary `SessionPanelDock` `onAttachImage` wiring. This is an unconnected Quick Chat callback rather than a staging/authorization failure.

**Reachability and limits.** The native File menu provides **New Window** (`main/menu.ts:42–47`, Cmd/Ctrl+Shift+N), renderer handles `menu:new-window` (`App.tsx:1462`), preload invokes `window:new` (`preload/index.ts:1408`), and Main creates another main window (`main/index.ts:5835`). A concrete supported UI arrangement is a Files Panel in window A and Quick Chat in window B. The fixture executes the actual source and target React handlers with the source-produced custom MIME. It does **not** perform a native Electron drag across two operating-system windows, so final inclusion can conservatively state: *an internal file-panel PNG payload delivered to Quick Chat is discarded*. No claim that every image drop fails, no claim of lost original image bytes or transcript data, and no claim of cross-window privilege bypass.

**Severity.** P3: an advertised input affordance silently fails on this internal-image path. OS file drag/paste/picker provides recovery. R05 concerns attachment state surviving a conversation switch; Q1 loses the image before it enters any attachment state. R06 concerns run reply envelopes; Q1 does not launch a run. R50 concerns recording resource ownership. It is independent of all three.

**Baseline.** `git diff 84740d56..a66f4ef2` is empty for `ChatView.tsx`, `QuickChatPanel.tsx`, `FilesPanel.tsx`, and `main/menu.ts`. This is an existing defect newly observed in this review, not a 0.9.33 regression. The QC behavior delivery document explicitly says Quick Chat retains attachment/paste/drop (`docs/todo/small-features-2026-07-10/PIPELINE-SUMMARY-QCBEHAVIOR.md:145`); old `TODO 2.1` comments label implemented file drag code and do not make this a deferred, absent feature.

**Reproduction.** `quickchat-lifecycle.test.tsx`, final test. Both actual components are imported, with no mock replacement of their handlers. Local file-system list IPC is a synthetic project list; its actual file rows produce the custom MIME. Assertions record 0 attachments/0 staging calls for the internal PNG, then successful internal PDF and OS PNG controls. `observations.json` records the outcomes.

## Normal contracts and rejected leads

- **No floating window or promotion feature.** This snapshot implements Quick Chat as a built-in session Panel. It has no standalone Quick Chat floating window, “move to main chat,” or “save as ordinary session” action. Existing research explicitly defers optional saving/promoting (`docs/research/quickchat-lifecycle-vs-codex-side.md`, sections 4–5). Closing an ephemeral child intentionally discards that child's draft/history. This was not counted as data loss. `AppQuickChat.test.tsx` “every elevation” means permission modes, not moving the conversation into main chat.
- **Repeated submit and busy/stop.** Separate Enter events send one original draft. Empty Enter, composing Enter, and shifted Enter do not submit. While busy and without `onQueueInput`, the actual Quick Chat composer keeps a newly typed follow-up. When busy clears it can submit. The real App controller existing tests independently verify quick/main bucket isolation and stopping only the requested child session.
- **Hiding is not closing.** Actual `PanelArea` tests verify mounted hidden/inactive bodies and inert focus boundaries. The real Quick Chat/ChatView fixture retains its text and dropped PDF across CSS hide/reveal. A genuine unmount followed by a fresh child identity starts without the old local path state. App integration tests cover close/replacement generation cleanup rather than assuming that a cosmetic hide should destroy the child.
- **Creating/error recovery.** `creating` and `error` omit the composer. Retry and explicit blank recovery remain available. Actual App integration tests cover a failed full fork, switching to blank while the fork is pending, deferred fork completion after close/unmount, and process-local expiry after worker exit.
- **Late attachment/fork work.** The actual Main `QuickChatOwnershipRegistry` defers cleanup while an attachment operation is in flight, marks the old claim inactive, and removes late bytes when the last operation settles. Closed ChatView ignores the completed attachment; the reopened child remains empty. Existing Main tests also exercise actual server storage deletion, other-window ownership, and the real `QuickChatForkRouter`. The custom fixture combines the real registry with a local staged-write double; it does not claim to execute the entire Electron Main entrypoint. Main production wiring is verified statically at `index.ts:4896–4933`, `index.ts:6748–6784`, and the inactive-run gate at `agent-bridge.ts:830–845`.
- **Promise error feedback.** Real App integration's rejected run case clears busy and renders an error. Native JSON-RPC envelope early-return error interpretation is the already-listed R06 and is not counted again. `modelSwitchRun.ts` is now an immediate `run(...)` passthrough, so there is no configure-await cancellation window there.
- No additional lifecycle defect was established for cancellation, repeated normal Enter, hidden/reopened panels, close during a deferred fork, or late attachment staging.

## Guarded validation

All four commands use the repository guarded runner, which creates an isolated real HOME and strips inherited credentials. `network-guard.ts` is preloaded before product-facing imports; five negative transport probes execute and global fetch/http/https/net/tls JS surfaces are denied. Each final shard records zero unexpected transports. This is a JS transport guard, not an OS sandbox. Window IPC, file list and stage calls are local doubles; no provider/worker is launched. Real Main ownership/router/storage code is exercised by targeted suites.

| Final log | Tests | Assertions | Skip | Fail |
| --- | ---: | ---: | ---: | ---: |
| `lifecycle.log` | 7 | 53 | 0 | 0 |
| `app.log` | 47 | 244 | 0 | 0 |
| `main-components.log` | 24 | 88 | 0 | 0 |
| `visibility.log` | 5 | 39 | 0 | 0 |
| Total, 10 test files | 83 | 424 | 0 | 0 |

The App suite emits an existing React `act(...)` warning in an external Goal projection test; all 47 tests complete, and this is not treated as a product defect. Preliminary temporary-fixture dependency/localStorage setup failures were fixed in the evidence fixture, with no product edits; only the final completed logs are counted above.

Run from the snapshot root:

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 --preload /tmp/codeshell-review-20261012-quickchat-round8/network-guard.ts /tmp/codeshell-review-20261012-quickchat-round8/quickchat-lifecycle.test.tsx
node scripts/run-bun-test-shard.mjs --timeout 30000 --preload /tmp/codeshell-review-20261012-quickchat-round8/network-guard.ts packages/desktop/src/renderer/AppQuickChat.test.tsx
node scripts/run-bun-test-shard.mjs --timeout 30000 --preload /tmp/codeshell-review-20261012-quickchat-round8/network-guard.ts packages/desktop/src/main/quick-chat-ownership.test.ts packages/desktop/src/main/quick-chat-fork-router.test.ts packages/desktop/src/main/quick-chat-startup-cleanup.test.ts packages/desktop/src/renderer/ChatView.ephemeral-lifecycle.test.tsx packages/desktop/src/renderer/panels/QuickChatPanel.test.tsx
node scripts/run-bun-test-shard.mjs --timeout 30000 --preload /tmp/codeshell-review-20261012-quickchat-round8/network-guard.ts packages/desktop/src/renderer/panels/PanelArea.keyboard.test.tsx packages/desktop/src/renderer/panels/PanelArea.workspace.test.tsx packages/desktop/src/renderer/panels/panelVisibility.test.ts
```

## 主审收束：R54 / P3

按上述保守输入边界列入正式报告，不将原生跨窗口拖动或图片字节丢失当成已验证事实。便携脚本位于 [`reproductions/quickchat-round8/`](reproductions/quickchat-round8/)，自身在产品导入前加载网络 guard，并按脚本位置定位仓库；两基线各7测试53断言通过。76个既有测试的复查日志在 `validation/quickchat-round8/`，已经包含于原基线6286测试，不再累计。guard JSON 只记录隔离HOME哈希与传输负探针，不将fixture编写基线冒充运行基线。
