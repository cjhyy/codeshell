# 更新安装 / shutdown 候选的独立挑战

结论：**候选未确认，不列正式发现，不复制到正式 reproductions runner。** 原 `updater-shutdown.test.ts` 的 3 pass / 18 asserts 是模拟 `app.quit()` 适配器下的 product 状态观察，不能当作 macOS 产品复现。Win/Linux 的实际平台闭环也尚未建立，不扩大推断。

审查固定最新工作区 HEAD `a66f4ef291f304ee4df9da8095a90671d9a8f140`，产品只读；读取已安装 `electron-updater@6.8.3`、`electron@33.4.11` 的代码和本地 API 类型注释。没有下载、安装、启动或退出操作者的 app，没有外部网络。

## 原 fixture 真正证明了什么

真实 [updater.ts:339](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/updater.ts:339) 设置 `installInFlight=true` / `kind=installing` 后调用 injected autoUpdater.quitAndInstall；真实 [desktop-shutdown.ts:17](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/desktop-shutdown.ts:17) 会 preventDefault，save 阶段拒绝后允许普通 quit 重试。若 injected updater 仅同步调用普通 `app.quit()` 且不发 error，状态确实一直 installing、显式更新入口暂不可用。

但 fixture 的 `process.platform="darwin"` 只影响 product 的签名分支；`autoUpdater.quitAndInstall = () => app.quit()` 自身没有模拟 MacUpdater / Electron native updater 的真实窗口关闭顺序、Squirrel 状态或 installer 行为。因此它不能把“正在显示更新按钮的存活 renderer save 拒绝”冻结为真实 macOS 触发。

## macOS 差异足以否定原平台结论

- 已安装 [MacUpdater.js:13](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/electron-updater@6.8.3/node_modules/electron-updater/out/MacUpdater.js:13) 直接继承 AppUpdater，**不是 BaseUpdater**；16 行取 Electron native autoUpdater。
- [MacUpdater.js:227](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/electron-updater@6.8.3/node_modules/electron-updater/out/MacUpdater.js:227) 默认 autoRunAppAfterInstall 走 nativeUpdater.quitAndInstall；236–249 行如果 Squirrel 尚未下载完成，先监听 native update-downloaded，再继续调用。产品 [updater.ts:219](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/updater.ts:219) 设置 autoInstallOnAppQuit=false，故 native download/check 可能直到显式 install 才启动，也不是 fixture 的直接同步 app.quit。
- 已安装 Electron 官方 API 本地文档 [electron.d.ts:168](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/electron@33.4.11/node_modules/electron/electron.d.ts:168) 明确 autoUpdater.quitAndInstall 发起退出时，before-quit 在所有窗口 close 并关闭后才发出；[electron.d.ts:1927](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/electron@33.4.11/node_modules/electron/electron.d.ts:1927) 再说明先关闭全部窗口，再自动 app.quit。1833–1838 行给 before-quit-for-update 作为关窗前事件。
- 真实 [session-catalog-ipc.ts:56](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-ipc.ts:56) flushRenderers 只向未 destroyed 的窗口索要保存 ACK。窗口全部关闭后，此段为空；后续 main catalog/transcript flush 等待的 pending 链分别在 [session-catalog-store.ts:173](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-store.ts:173) 和 [session-transcript-cache.ts:123](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-transcript-cache.ts:123) 已 catch 先前拒绝。没有证据证明原 fixture 的 renderer save failure 在此顺序仍会发生，也没有原 fixture 所保留的存活更新 UI 可操作。

本地 API 文档也说明 before-quit 可以 preventDefault，但“可阻断退出”本身不足以证明“更新页面可见、renderer 保存拒绝后安装按钮冻结”的完整 macOS 流程。此处不进一步推导关窗前 persistence 的其他问题；那需要独立真实生命周期证据。

## Win/Linux 也不能直接沿用原影响

- [BaseUpdater.js:12](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/electron-updater@6.8.3/node_modules/electron-updater/out/BaseUpdater.js:12) 先同步 install / doInstall，成功后才 setImmediate → before-quit-for-update → app adapter quit；[ElectronAppAdapter.js:31](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/electron-updater@6.8.3/node_modules/electron-updater/out/ElectronAppAdapter.js:31) 的确转普通 Electron app.quit，可被 before-quit 保护阻断。
- 但 install 已在 quit 前触发，BaseUpdater 也已把 quitAndInstallCalled 置 true（54 行）。[NsisUpdater.js:101](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/electron-updater@6.8.3/node_modules/electron-updater/out/NsisUpdater.js:101) 真实安装分支启动 installer / elevation（123–148 行）；[AppImageUpdater.js:72](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/electron-updater@6.8.3/node_modules/electron-updater/out/AppImageUpdater.js:72) 已移动/替换 AppImage 并可能启动新进程（95–110 行）。所以模拟“installations++ 但无安装器”的 fixture 尚未证明安装实际停下、失败、无法恢复或状态不真实。
- 即使普通 quit 在存储恢复后能成功，也只说明 shutdown handler 可重试；原 fixture 没有真实平台 installer 的退出/等待/取消结果，不能据此断言 updater P3。

## 处理建议

保留原测试及日志为 `/tmp` diagnostic，结果描述用“在模拟普通 quit 适配器下观察到 installing 状态未回退”。不把它计入正式发现，不指定 macOS，不扩大至 Win/Linux。以后若需要推进，应另以明确平台的受控打包 app / installer lifecycle 证据建立触发与最终影响；本次不运行真实更新流程。
