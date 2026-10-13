# CodeShell review 独立证据审计

审计基线：`84740d56e55517b004948a0a0e07649ad6fbf998`，工作区 `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`。先读取了 `CODESHELL.md`。本轮只读产品代码、专项复现脚本和既有日志，没有重新运行进程、修改产品、访问外部服务、真实 HOME 或模型。

## 结论

本轮优先核对的 D13、D1/R06、R21、W11/R33 主结论均成立，没有发现应撤销的正式发现。D13 的 P1 级别有依据：正常 UI 可发出相同并行请求，失败方缺少创建所有权检查，真实 Git 的强制删除确实作用于成功方的 checkout；非提交文件的损失是有条件的真实后果。建议对 D1 的传输失败措辞、R21 的客户端适用范围作两处收窄，详见下文。

## D13：工作区重复创建与错误回滚

**成立；入口和回滚链均可达。** `WorkspaceIndicator.tsx:600–634` 的 `switchTo`/`createNew` 只拒绝 `sessionBusy`，不拒绝 `busyAction`；`:842–844` 输入框 Enter 直接调用 `createNew`。`:853–854` 确实禁用 Create 按钮，但不会禁用输入框或其按键事件。既有 UI 复现第一次 Enter 后先确认 Create 已 disabled，再触发第二次 Enter，记录了两个完全相同的 `switchSessionWorkspace` 调用，符合跨 React render 的正常用户操作。

`project-authority-ipc.ts:286–309` 的实际 `workspace:switch` handler 没有 per-session/target 锁；`session-workspace-service.ts:511–561` 也没有锁。service 在 `listWorktreesFast` 找不到目标时调用 `createWorktree`，后者依次完成分支占用、分支存在和目录存在检查，之后仍有异步 Git 查询，两个请求可以在分支/目录建立前同时通过这些检查。生产的 mounted-root/known-session 校验不会阻止同一个合法闲置会话执行这两个请求；测试使用持久化的真实 SessionManager，并未用传入 cwd 替代权威 session root。

`crud.ts:176–181` 对 `git worktree add` 失败也调用 `cleanupAbortedWorktree`；后者 `:79–87` 先无条件运行 `git worktree remove <path> --force`，再 `git branch -D <branch>`。`worktreePathPreexisted` 只限制 remove 失败后的递归删除 fallback，既不能阻止强制移除已注册 worktree，也不能证明当前调用拥有同名 branch/path。即使该 Boolean 为 true，首个强制删除和 branch 删除仍会被尝试；并发场景中两个调用则都可能记录 false。

**Git barrier 的证据有效，但只证明一种允许时序，不代表发生频率。** `/tmp/codeshell-review-20261012-desktop-round3/worktree-duplicate-create.test.tsx` 的 wrapper 在 `worktree add` 进程入口 gate 两个调用，因此 gate 之前的全部生产前置检查已经结束。实际工作由真实 Git 完成；第二个 add 只延后启动，真实失败后延后退出/输出，未伪造成功、错误、文件、branch 或 cleanup 调用。生产异步进程没有规定这两个完成回调的先后，因此这是合法的竞争调度。测试随后在成功 IPC 已返回时写入一个非提交文件；既有日志确认删除前 path/file/branch 均存在，失败回滚后均不存在，Session.workspace 仍指向删除路径，且只有一次成功 workspace:changed 广播。

限定条件应保留：需要两次创建前置检查重叠；若第二次在第一次 branch 创建后才到达，前置拒绝可能避免错误回滚。非提交内容损失还要求其在成功创建之后、失败回滚之前写入；测试为确定性地观察这个条件而延长了失败回包窗口，没有证明普通双 Enter 一定给用户留下同样长的编辑时间。P1 的依据是可达的破坏性错误回滚，而非已测得的高发生率。

既有日志：`worktree-duplicate-create.test.tsx.log`，2 pass / 0 fail / 15 assertions。测试分开验证 UI 双请求与真实 Main/Git 后果，没有把二者宣称为同一 Electron 端到端操作。

## D1/R06：原生 run 错误回包

**核心结论成立。** `preload/index.ts:263–267` 用完整 JSON-RPC envelope resolve pending RPC；`:548` 的 run 直接返回 `rpc(...)`。`renderer/modelSwitchRun.ts` 原样返回 run 结果，无隐式 unwrap。普通 send 的 `useRunController.ts:486–497` 和 Quick Chat 的 `:639–644` 却从顶层读 `reason/text`，既看不到 envelope 内的 `result.reason`，也不处理根 `error.message`。

实际 Main configuration/root-migration gate 在 `agent-bridge.ts:804–824` 回错误 envelope 后直接 return，不向 worker 转发，因此没有错误 stream 可兜底。Core `engine.ts:1590–1598` 的附件准备失败直接返回 image_error；ProtocolServer `handleRunMulti` 在返回 EngineResult 后发送 `createResponse`，并未统一补发 error/turn_complete；另有 runAccepted/user-message 通知不等于可见错误解释。`ChatView.tsx:1094–1109` 调用 onSend 后立即清空草稿和附件，因而报告所述“用户消息保留、busy 清除、发送错误理由消失”有完整链路。

真实 preload envelope 复现与实际 controller 复现可以互相衔接：前者证明原生返回形状，后者证明真实 hook 对相同形状不发 turn_end/toast；裸结果对照组能显示错误。无需假设 renderer 使用了错误的 mock API。

**建议收窄一句：** 附录中的 “Transport failures are also only logged” 应写为“普通 send 在目录保存成功后的 Promise rejection 只记日志，没有对应 turn_end/toast”。不能扩写成所有传输/worker 失败在整套 UI 都完全无反馈：`useHostSubscriptions.ts:1008–1025` 对非零 worker exit/gave_up 设置全局 lifecycle 文案，`AppShell.tsx:34–36` 会显示；Quick Chat 的 `useRunController.ts:651–663` catch 也会输出 turn_end/toast。这不影响 configuration gate/image_error 的主缺陷，也不影响普通 send 缺少具体错误理由的结论。模型已经输出错误 stream 的场景同样不应被概括为全部隐藏。

## R21：首次运行中的恢复

**成立，且不是只有日志样本的一次性断言。** `headless-server.ts:1062–1067` 对尚未落盘的新会话取 baseline=0，`:1134` 交给 HubRunReplay。journal 分支 `:1460–1478` 已读到 complete legacy base，仍把同一 transcript 传给 `runReplay.snapshot`。`hub/run-replay.ts:192` 在 RAM log 未 truncated 时按旧 baseline 截断，故首个 worker 后来创建的 session_meta anchor 被裁掉。`finish` 的 `:137–145` 最后一个请求结束后释放 RAM log，所以结束后重开是合理恢复路径。

保存的真实响应 `reproductions/root/active-snapshot-journal.json` 同时具有 running=true、outputJournal.status=ok、legacyBaseComplete=true、非空 legacyBaseThroughEventId 和 transcript=[]；其 frames 还包含 user message、session_started、stream_request_start 与 text_delta。`chat.ts:102–107` 确定拒绝该输入；`useHubController.ts:298–313` 将 durableFailed 置为恢复阻断、显示无法验证记录的提示并保留现有可见内容，而非无条件回退接受 RAM snapshot。之后的 live event 还受 `outputRecoveryBlocked` 约束。这证明用户可见恢复失败，不只是服务端响应格式不理想。

既有 smoke 日志说明这是实际 Node Hub + Core worker + 本地模型 SSE 的首次运行中查询；专项 2 pass / 8 assertions 则固定该响应并独立验证零 baseline 的切片机制。健康 journal 日志和 RAM overlay 恢复冲突并不矛盾。

**范围建议：** 总表/小标题加“原生 Hub Web”或“Hub 新会话”。已核对的生产客户端是 `packages/web/app/useHubController.tsx` + `chat.ts`，不能由这份证据推导 Electron Desktop 或配对手机的其他恢复实现全部有同一缺陷。首次运行未结束、baseline=0、RAM log 未 truncated 是当前已证实窗口；不能笼统称所有首次会话恢复或持久日志已损坏。

## W11/R33：手机新会话草稿归属

**成立；既有生产门禁不能阻止此路径。** 手机入口 `desktop/src/mobile/main.tsx:4,14` 挂载共享 DesktopApp。`useRemoteApp.ts:1464–1522` 新建动作建立 pendingCreateRef 并清空 boundSessionRef；`:768–771` 在 boundSessionRef 为空时用第一条合法 session.stream 自动绑定，没有检查 pending create。`DesktopApp.tsx:253–265` 的第二个 layout effect 只观察任意新 activeSessionId，随即消费自己的 pendingCreate 并移动文本/附件草稿。后到的正确 ACK 再绑定新 session 时，迁移机会已经消耗。

ACK 的 clientRequestId、conversationRevision、connectionGeneration 检查 `useRemoteApp.ts:568–597` 本身存在且有效；错误发生于 ACK 之前。`MobileOutputClient.observe` `:116–124` 对 session.stream 返回 false；stream handler 是先修改 binding，再调用 output recovery。因此开启 outputJournal:1 并不会先阻断错误 binding。复现确实保留了该能力协商。

后台帧可由真实生产路径发送：`desktop/main/index.ts:1731–1749` mirror 每个 worker stream；`remote-host-manager.ts:484–485,543–550` 广播给每个已认证 socket，不按当前选中会话筛选。`handle-client-event.ts:317–343` 的创建 target 校验及带 clientRequestId ACK 没有串行化另一 worker 的输出；请求尚在路上、legacy cwd 校验 await 或 ACK 传输期间均可收到后台合法帧。无需绕过 root/project 权限、伪造 ACK 或假定请求按错误顺序被服务端处理。

现有 fixture 的 stream seq/epoch/outputCursor 是简化控制值，并未连接真实 worker；不过自动绑定只要求正整数 seq、未绑定及非 room，且发生在 cursor 验证/恢复之前。真实任意合法后台 stream 同样满足这些条件，故这些简化值不构成不可达前提。既有日志证明 local-new → unrelated-background → actually-created，最终草稿仅在后台会话可找回。报告已正确限定为草稿迁移和上下文误导，没有据此声称错误任务已执行或草稿永久删除。

## 报告一致性提示

读取时正式 README 仍列 34 项、Desktop round3 2 文件/2 测试，没有同步 D13；父代理已说明正在同步。读取时 `/tmp/codeshell-review-20261012-web-round3/mobile-lifecycle-review.log` 已更新为 5 pass / 43 assertions，而正式 web-round3 附录和复现副本仍是 3 pass / 25 assertions；这看起来是并行收束中的版本差异，最终交付时应统一脚本、日志、测试数量和正式发现，避免把临时新测试数量混入旧版摘要。本审计未将该更新中差异视为产品缺陷。
