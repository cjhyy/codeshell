# Link 授权与连接恢复边界检查

本轮为静态调用链复查与既有测试证据核对，没有新增正式问题，没有重新运行完整测试或使用真实第三方账号。核对快照为 `a66f4ef2`；下述主要授权文件与初始 `84740d56` 的差异为空。

- Desktop 授权弹窗持有明确的 controller/request ID；真实 detach 会 dispose 并补 cancel startup request。切换认证方式先等待原授权取消，不直接复用仍 pending 的任务。见 `packages/desktop/src/renderer/credentials/LinkConnectionDialog.tsx:89–105,138–149`。
- 共享 `LinkAuthorizationController` 的 begin/respond/poll/cancel 用 generation 拒绝旧回包，尚未确定的写入通过 read reconcile，不自动重放凭据提交。不同 provider、缺失持久 connection 的 connected 响应均拒绝。
- Native manager 把 owner/request/job 关联；取消尚未完成的 browser open 会 abort 并关闭迟到的窗口句柄。Main IPC 在主 frame、主窗口与项目授权检查后建立 owner，导航或销毁会 close 全部该 owner manager。
- 服务端更名、重连和删除保留 expectedRevision/CAS；project scope 连接是只读。远端 disconnect 先禁用本地使用，撤销失败保留 disabled record 供重试，不能将远端超时表述成成功撤销。

已核对现有 guarded 基线日志：`validation/server-web-results.json` 中的 `links/service.test.ts`、`links/remote-authorization.test.ts`、`links/browser-handoff.test.ts`、Web `link-authorization.test.ts`，以及 `validation/desktop-main-results.json` 中的 `link-authorization-manager.test.ts`。这些已经包含在 706 文件 / 6286 测试内，不额外累计。

`useRemoteLinkSnapshot` 只对 cwd / 生命周期换代，没有逐次 reload 的请求序号，存在静态上的同上下文响应排序疑点；但 Main 在远端 catalog await 完成后才构建当前 snapshot，单纯用手工延迟旧 snapshot 的 mock 不能证明可达的旧状态覆写。本轮没有把此猜测列为缺陷，也没有据此声称并发刷新流程全面无问题。
