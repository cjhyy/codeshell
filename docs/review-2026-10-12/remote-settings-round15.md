# 第十五轮：Desktop 局域网远程入口状态同步

正式发现 **R67/MR1/P3**：在另一处已挂载的设置视图开启LAN入口后，观察方仍显示“已关闭”，开启可用、关闭禁用。重新挂载页面或在观察方再次点击开启可恢复，后者复用相同实际listener端口。独立只读质量复核认可该P3及有限恢复范围。

冻结产品快照 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，已读CODESHELL.md及R01–R65/auth-round7/flow-coverage。产品不改，没有build/clean、真实Electron/CLI/worker/模型/账号/cloudflared/外部网络。报告与脚本仅本任务/tmp。

## R67/MR1/P3：LAN成功启动没有向其他已挂载设置视图通知最终状态

主要位置：[mobile-remote-controller.ts:251](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:251) LAN start成功返回前没有publish；[AdvancedSections.tsx:1703](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/AdvancedSections.tsx:1703) 只有发起方在await start后自行refresh。观察方仅在[挂载:1654](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/AdvancedSections.tsx:1654)及tunnel/relay状态通知时refresh；[onlineChange:1687](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/AdvancedSections.tsx:1687)只更新在线设备集合，不更新running。没有focus/timer/storage刷新。

实际生产多窗口入口：[menu.ts:44](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:44) 新窗口→renderer菜单事件→[Main window:new:5835](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5835) createWindow，加入同一mainWindows集合；[SettingsPage.tsx:817](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/SettingsPage.tsx:817) 每窗可挂MobileRemoteSection。Main [index.ts:1029](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1029) 仅创建一份DesktopRemoteServices/controller/host并传入全体mainWindows。[desktop-remote-services.ts:60](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/desktop-remote-services.ts:60) 广播是relayStatusChanged，不是所有transport的通用状态；LAN start没有触发它。

最小触发：两窗都先打开手机遥控设置，初始LAN入口关闭，未登记relay；B点击“开启手机遥控”，B显示真实URL及二维码，而A继续显示已关闭，start可用、stop禁用。A仅等待/手机在线集合更新没有使其刷新running。该条件不要求网络错误或异常响应。B在同页正常start/stop状态更新，不属于所有开启操作都失败。

## 实际复现与正常恢复

[remote-settings.test.tsx](reproductions/remote-settings-round15/remote-settings.test.tsx) 动态执行完整实际MobileRemoteSection及I18n/Dialog/Toast providers、实际preload mobileRemoteApi/deviceRelayApi、createDesktopRemoteServices→registerDeviceRelayIpc→MobileRemoteController→RemoteHostManager。真实TrustedDeviceStore和隔离应用路径均在owned临时目录。真实HTTP listener只绑定127.0.0.1，Host.start边界将生产LAN地址选择替换为loopback，保留真实启动、status、pairing和stop；没有HTTP/WS客户端发送、实际LAN暴露或模型运行。

UI选择器绘制和QR编码是替身，QR仍只用owned生成链接；IPC transport/WebContents/OS safeStorage为替身。两份组件根在同一miniDOM、共享同一IPC替身sender，并非两个独立Electron renderer；完整多窗口入口与合法owner关系仅源码核对。该实验不能声称native多窗视觉、手机配对或LAN实际可达均验证通过。表征时从实际组件按钮handler发起操作，无手改组件status，也没有制造迟到IPC。

最终日志 [remote-settings.test.log](validation/original-remote-settings-round15/remote-settings.test.log)：**3 pass /23 assertions /0 fail/skip**，含guarded Completed。1项候选及2项正常/恢复控制，不是3个新问题。

1. 两组件挂载完成后由actor点击正式start；真实Host running=true、mode=lan、有真实本地端口，actor显示该URL。observer仍已关闭，其start enabled/stop disabled。start后只有actor一次status请求，relayStatusChanged事件为0。卸载重挂observer后自动显示URL。
2. actor启动后observer再点start，先确认observer显示running；actor点击stop后真实listener关闭，两视图都显示已关闭，生产relayStatusChanged确已发出且两个preload listeners在位。此项动态证明running→stopped，不只是从始至终都closed。
3. stale observer的start重试复用同一个真实端口，双方显示running，没有第二个listener；真正IPC owner/frame gate拒绝subframe和非同一WebContents对象的调用，原listener仍在。

恢复与分级：离开手机遥控设置再返回会remount并refresh；再次点击开启也因[controller.ts:220](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:220) 同mode/url分支复用已运行Host并生成自己的pairing链接。已有恢复、实际服务正确工作，影响是陈旧状态和禁用关闭入口，建议P3。未据此声称数据丢失、越权、真实手机断线、两个listener泄漏或必然改变其他人的传输方式。

与R47自动化页漏订阅自动停用不同，这里是LAN成功提交没有广播最终gateway状态；与R61共享会话选择互相抢导航不同，不涉及session选择或草稿。相同“多窗口”场景不代表相同代码根因。建议所有transport在完成/失败/关闭后发布统一gateway status，UI按该状态订阅；保留IPC owner/frame门禁以及同mode幂等启动，不靠放宽权限或假定手机online-change等于服务running解决。

## 隔离与日志溯源

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/review-2026-10-12/reproductions/remote-settings-round15/remote-settings.test.tsx
```

脚本首先检查CODE_SHELL_TEST_HOME与隔离HOME，在Core/Host导入前安装exact-origin `http://127.0.0.1:9` 守卫；该origin未请求。只创建owned loopback listener，不接触系统账号/凭据。afterEach卸载UI、dispose实际controller、停止host、删除自有临时目录；CloudAccountManager本轮没有启动认证或请求，因此无认证operation待清理。该类没有dispose方法，不杜撰调用。

首次[失败日志](validation/original-remote-settings-round15/remote-settings.harness-failed.log)是miniDOM text helper未读nodeValue和cleanup误调用不存在的cloudAccount.dispose；未点击start、未启动listener，不计产品失败。修正fixture后两份空owned临时目录已清理。早版2/15与补preload后的3/22日志分别保留initial-pass/control22；最终补齐observer先running后stop对照为3/23，不重复累加。相关5个生产文件在84740..a66f间diff为空；目前原始运行仅a66f，主审若在两基线便携复跑需另记结果。

## 主审便携复核

`reproductions/remote-settings-round15/remote-settings.test.tsx` 在84740与a66f分别guarded通过3测试23断言，0fail/skip，最新日志已归档。不因两React根模拟而宣称真实Electron双窗口或LAN手机配对实测；完整生产多窗口入口仍为源码证据。独立结论见[远程设置质量复核](remote-settings-quality-round15.md)。
