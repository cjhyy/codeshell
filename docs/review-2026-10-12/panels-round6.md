# 第六轮 Panel stable project scope 差异复查

本轮固定快照 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，比较 `84740d56..HEAD`。工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，分支 `codex/review/latest-20261012`。已读取该快照 CODESHELL.md，并读取原审查工作区 `docs/review-2026-10-12/README.md` 的 R01–R48 索引；避免重复 R22/R23/R24。未更改产品、未重新构建、未运行真实模型或外部服务。最终 `git status --short` 只有主代理正在保存的 `?? docs/review-2026-10-12/`，无 tracked 产品变化。

结论：**本轮无新增正式发现。R22 在最新快照仍成立；另记录一个已验证的 legacy Session 边界，不计问题数。** 新增 scope 对正常 primary、Git worktree、分别保留的会话 Panel 实例、持久 storage 及异步提交边界未发现误拒绝。

## 验证与证据

| 检查 | 结果 | 文件 |
| --- | --- | --- |
| 现有 native/server scope、Main bind/storage/agent/automation 栅栏 | 3 文件，29 测试，127 断言，0 失败/跳过 | `existing-scope-tests.log` |
| 现有真实 Web runtime HTTP fixture | 1 文件，1 测试，1 外层断言，0 失败/跳过；内部 Node assert 包含权限、省略 scope、撤销、storage 最终提交检查 | `http-scope.log` |
| 自定义实际 renderer hook/selector/PanelAppHost/Main 方法组合 | 1 文件，3 测试，26 断言，0 失败/跳过 | `native-lifecycle.test.tsx`、`native-lifecycle.log` |

合计 **5 文件、33 测试、154 个 Bun expect、0 失败/跳过**。Bun 测试通过代表契约/边界已复现，不表示旧 R22 已修复。非 Git fixture 的 `fatal: not a git repository` 是已有项目解析探测的 stderr，guarded runner 最终成功；没有未处理 React act 警告。

复跑命令（在上述工作区）：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/server/src/panels/project-scope.test.ts packages/desktop/src/main/panel-project-scope.test.ts packages/desktop/src/main/panel-project-binding.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/server/src/panels/project-scope-http.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-panels-round6/native-lifecycle.test.tsx
```

前两组使用仓库既有测试；第三组的支架来自既有绑定测试，但由 TypeScript AST 重新抽取并执行最新生产 `PanelAppBridge` 方法，未重写其逻辑；renderer 使用真实 `useRunController`、`switchActiveModel`、`PanelAppHost`，项目使用真实 ProjectStore 和新 resolver。Electron window/guest、descriptor 选择/授权及 IPC 传输是本地支架；不声称启动了真实 Electron 或某个已安装 Panel 包。

所有 Core/Host 动态导入之前先安装仓库 exact-origin guard。普通 scope/native fixture 还阻断 fetch/http/https/net 全部连接；HTTP fixture 只放行自己临时监听的 `127.0.0.1:<port>`。guarded runner 提供隔离 HOME/状态并剥离凭据；所有持久操作只写自有临时目录，结束删除。没有请求真实任务、真实模型或账号。

## 旧发现去重：R22 未被 stable scope 修复

操作：正常多根项目中，会话已合法迁移到已注册 secondary root，再打开该项目已绑定 Panel。

最新生产链：

- `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/SessionPanelDock.tsx:164–185` 从 bucket 的 projectId 取整个项目，并把 `panelProject.path`（primary）传给 Panel；同组件 `:212` 传自己的会话 ID。`PanelArea` 使用会话权威解析执行 cwd。
- `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/panel-app-bridge.ts:1001–1007` 仍把 `resolvePanelAppBindingProjectPath(input.cwd)` 与准备时 primary 项目路径比较；两个独立、合法的非 Git root 会被判不相等。
- 新 scope resolver 到 `panel-app-bridge.ts:1029` 才调用。因此 R22 先在旧预检抛 `Panel App workspace does not belong to its bound project`，新的注册项目身份根本没有机会决定归属。
- `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/panel-project-scope.ts:21–39` 对各 root 本身能解析正确；但把 primary 当 `projectPath`、secondary 当 `cwd` 仍会触发 topology 归属限制，不存在新 scope 自动挽救旧 preflight 的路径。

`native-lifecycle.test.tsx` 的第二项通过真实 ProjectStore `createFromPath`/`addRoot` 注册 primary、secondary；分别捕获的 scope 具有同一 projectId、不同 rootId，`resolveExactRootSync(secondary)` 正常返回挂载 root。传入生产 Main bind 后失败且 resolver 调用数为 **0**，见 `secondary-root-observed.json`。这补强最新适用性，不另编号；完整会话迁移和 UI 打开失败的原始生产复现仍引用原 R22。Git linked worktree 的 binding path 会折回主仓库，不能把本结论扩大到所有 worktree。

## 已验证边界：legacy engine ID 在模型切换时要求重开 Panel

此项**不列正式问题，也不定 P2**。敏感会话保护是明确设计，错误包含重开指引，重开后恢复；当前没有冻结具体 Panel 包的 guest 界面失败呈现，不能只根据 Host 不自动重开而断言流程故障。

形状与正常可达性：

- `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useRunController.ts:234–247` 明确支持旧 auto-bound 会话 `summary.engineSessionId !== UI session.id`；`renderer/streamRouting.test.ts:75–88` 保留此兼容性测试。不是任意伪造不合法记录。
- `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1659–1672` 的正常模型选择入口调用 `switchActiveModel`；`renderer/app/switchActiveModel.ts:39` 更新当前 bucket 模型。
- 同一个 `projectId::UI-sessionId` bucket，`useRunController.ts:1005–1015` 在原生模型使用 legacy engine ID，在 Codex/Claude 外部模型使用稳定 UI ID。选择模型即能改变 Panel 收到的 engineSessionId，不必发送任务。

实际观察（`legacy-model-switch-observed.json`）：

1. 真实 ProjectStore 的有效 primary 项目，UI ID `legacy-ui`、engine ID `legacy-engine`；打开 Panel 后捕获有效 projectScope，`automations.list` 正常。
2. 通过真实 `switchActiveModel` 选择 `codex/gpt-6.1-sol`，真实 hook 返回 `legacy-ui`。`PanelAppHost` 沿用同一个 guest：prepare 仅一次；bind 成功且 context 更新；projectScope 全部字段不变、其 assertCurrent 仍通过。
3. `panel-app-bridge.ts:1060–1063` 识别首个真实 session ID 已变并永久置 sensitiveSessionRevoked。后续实际 `call("automations.list")` 和 `call("agent.submitPrompt")` 均在 `:1284–1287`、`:1783–1786` 返回 `SESSION_CHANGED: Panel session changed; reopen the panel`，没有调 Host list 第二次，也没有派发 run。
4. 项目级 storage 写入继续成功。fresh guest 绑定当前 ID 后 `automations.list` 正常，说明关闭该 Panel tab 后重新打开可恢复。
5. 现代 `UI ID == engine ID` 的正向对照做相同模型选择，scope 相同、sensitiveSessionRevoked 未置位，automation list 正常。

保护与呈现边界：`/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/panel-app.ts:94–104` 会保留结构化 code/message，并抛给 guest；Host `PanelAppHost.tsx:109–115` 只处理 bind 成败，此处 bind 成功，因此不显示自己的 failed/retry UI。**这不证明 guest 没有呈现重开指引。** 未运行冻结的具体 guest action UI，不声称用户看不到错误，也不声称切回模型一定自动恢复。可作为未来“路由 Session ID 改变时主动重开 guest”的体验改进线索，当前不增加审查计数。

## 正常与恢复路径的保护证据

### 会话、项目和 worktree

`SessionPanelDock.tsx:161–185` 为每个 bucket 单独渲染 `key={panelBucket}` 的 PanelArea；`PanelArea.tsx:457–468` 保留各自 tab body。普通 A→B→A 会话切换只改变可见性，不能推论同 guest 被改绑 B。`PanelAppHost.tsx:55–82` 的 prepare 依赖 cwd/projectPath，正常会话执行 root 改变会重新 prepare，旧异步结果用 alive 标志丢弃。

`panel-app-bridge.ts:1013–1059` 的 AbortController/generation 防止迟到 bind 覆盖新结果，异步解析后重新检查 window、guest、Host、project；busy/theme 更新复用已捕获 proof。既有真实方法测试覆盖“旧 bind 后完成”“guest 关闭取消 pending”“owner 授权变化”“冻结 scope 反复检查”。未发现普通 UI 切换因此恢复到旧身份。

`panel-project-scope.ts:21–48` 使用 registry project/root ID，并重读 exact lookup 与 ID lookup；`server/src/panels/project-scope.ts:103–137` 在环境初始化 await 两边检查权威，冻结 environment/project/execution root，失败后不可复活。scope 不包含 Session ID，不授予额外权限。现有测试验证 native/paired 同环境同项目同 root 的字段完全一致；不同环境、注册 root、execution worktree 不混同；普通 root 内容变化不改变 scope；same-path mount、环境文件、注册 ID 的真实改变撤销旧 proof。有效 linked Git worktree 与 main 共 projectId、异 rootId；未发现正常 Git linked worktree 被新 resolver 误拒绝。

### storage 与 workspace 写入

`panel-app-bridge.ts:2868–2898`、`:2927–2943` 使用真实授权函数作为 beforeCommit 与最终同步 fence；`:2958–2979` 在排队、prepare、锁重试后检查 live binding。`server/src/panels/runtime-services.ts:205–232` 传递同样的 publication hook；`server/src/panels/storage-store.ts:223–228` 在第二次 prepare 后做同步 fence，接着 renameSync，减少异步授权检查与提交之间的 gap。不是把 projectScope 当 storage key，既有 app/project storage 布局保留。

现有测试确认普通 create/replace、storage 原值读写仍可用；queued/staged 的 root/parent 真正替换或 registry/guest 撤销后拒绝提交，旧 storage 保持原值。HTTP fixture 在最终 storage prepare 暂停后撤销 mount，返回失败且磁盘仍是 first 值。临时 parent 被移走后的清理策略属于明确绑定撤销范围，未把这种人为拓扑改变误写为日常误拒绝。

### agent 与 automation

`panel-app-bridge.ts:3103–3111` 在 external initialContext await 后、ensure 后分别检查 session；`:3125–3135` 在原生 agent/run 派发边界检查并使用快照 bucket。现有 fixture 在 await 期间 rebind，断言没有 ensure/send 或 worker dispatch。没有真实模型调用。

`panel-app-bridge.ts:2382–2405` 给 conditional automation 传递授权函数和同步 session fence；`panel-automation-host.ts:26–35` 先解析 durable Session 权威，再 await 第二次 authorization，随后同步 fence，再取 scheduler；`:37–41` 检查 resumeSession/project/root/canonical cwd。现有真实 Host fixture 在 durable authority await 期间变化，验证 scheduler 未被修改。此处保护是正常的 late-result 拒绝，未列误拒绝问题。

### Web/Hub grant

`server/src/panels/runtime.ts:1382–1392` 仅对 context.workspace 权限捕获 Host proof，不接受 caller 伪造 identity；`:1147–1188` 在授权、snapshot/owner/package 工作前后校验已冻结 proof，失败 remove grant；`:1858–1884` 提供 storage publication fence。实际 HTTP fixture 确认无 workspace 权限时不暴露 scope，伪造 request 字段遭拒，scope 本身不能扩大 method 权限，mount 更换后 context/后续调用返回 410，fresh capture 后普通 storage 正常。未在本轮扩大到凭据、网络攻击或外部模型执行。

## 保留范围

本轮只复查 stable project scope 差异和正常恢复/误拒绝；不重复 R23 全局发现批量失败或 R24 项目移除清理。没有运行已安装真实 Panel/用户数据，故不对某 Panel 的 guest 错误呈现作确定结论。旧自动化 R44–R48 的最新适用性由主代理独立移植复现，本附录不重复计数。
