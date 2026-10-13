# 第十八轮：Desktop 模型选择与失败恢复

审查快照为 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。已读 `CODESHELL.md`、主报告 R01–R73 / flow coverage、R25/R28/R29/R66、既有模型设置 Electron E2E 日志及模型/队列相关源码和单测。本轮产品、主报告、dist 均只读，没有构建、原生 Electron、真实 worker/CLI/模型/账号或外网操作。

结论：提交 **M18-1 / P3 单项候选**，影响限定为不同窗口间的模型持久选择投影被旧整图覆盖。其他配置 ACK、busy、队列和预设检查收窄如下，不另列问题。候选尚交 root 独立裁定，不自行编号。

## M18-1 / 建议 P3：第二个已打开窗口改自己的模型，抹掉第一窗另一会话的已存模型选择

### 正式入口与生产根因

1. [CommandPalette.tsx:189](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/shell/CommandPalette.tsx:189) 的“新窗口”/`Cmd+Shift+N` 调用 `newWindow()`；[preload/index.ts:1408](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:1408) 经 IPC 到 [main/index.ts:5835](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5835) 的 `createWindow()`，并非仅测试添加的多个视图。
2. [main/index.ts:1370](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1370) 的主窗口 webPreferences 没有另设 `partition` 或 `session`，[同文件:1390](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1390) 明确注明 default session 跨窗口共享；[同文件:1492](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1492) 给每个主窗口加载同一个 dev URL 或同一个打包 `index.html`。因此它们使用相同存储 scope。这里是源码接线证据；本轮没有把共享 MemoryStorage 冒充实际 Electron localStorage 实测。
3. [App.tsx:340](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:340) 将当前模型取为 `modelOverrides[activeBucket] ?? defaultActiveModelKey`。正式 [ChatView.tsx:2069](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/ChatView.tsx:2069) 挂载实际 `ModelPill`；[App.tsx:1659](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1659) 的选择回调进入 `switchActiveModel()`。
4. [switchActiveModel.ts:39](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/switchActiveModel.ts:39) 仅更新当前窗口 React map 的目标 bucket，逻辑本身保留该窗口其他字段。但 [useBucketOverrides.ts:30](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useBucketOverrides.ts:30) 只在该窗口初始化时读共享 projection；[同文件:36](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useBucketOverrides.ts:36) 每次变化整图保存，没有接收跨窗口更新或字段级合并。[transcripts.ts:268](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/transcripts.ts:268) 的 `saveOverrideMap()` 对同一个 `codeshell.overrides.model` key 执行整个 `setItem()`（空图会 `removeItem()`）。所以已挂载 B 后保存的是 B 旧内存图，不会合入 A 刚保存的 bucket。

选择两个不同项目 P-A/S-A、P-B/S-B，避免 R61 同项目目录选择互相覆盖的已知行为。A/B 均先打开、尚无任何模型 override。A 选择合法模型 alpha，projection 得到 `{A:alpha}`；B 随后在自己的正式模型选择器选择 beta，projection 变成 `{B:beta}`，A 的值消失。A 当前 UI 仍显示其内存中的 alpha；重载/重开 A 后真正的 lookup 回到默认模型。该路径不要求 Core 拒绝、忙任务、异常存储、并发写瞬时竞速或外部 CLI。

### 已执行证据与影响边界

[model-preferences.test.tsx](/tmp/codeshell-review-20261012-model-switch-round18/model-preferences.test.tsx) 使用实际 `ModelPill`、`useBucketOverrides`、`switchActiveModel` 和 `load/saveOverrideMap`；两个 React root 各自持有偏好状态，使用共享 MemoryStorage 模拟源码所示的相同存储 scope。选项通过实际渲染按钮的 React `onClick` 进入生产选择器，不直接调用 setter。组件壳提供与 App 相同的 bucket/model lookup 和 callback 参数；Main/preload configure 为记录适配器。native→native 本用例不走 external 的 session index rebind 分支，因此 `setSessionIndices` no-op 不影响被验证路径。mini DOM 的几何值为布局替身，不评估布局。

最终 [model-preferences.test.log](/tmp/codeshell-review-20261012-model-switch-round18/model-preferences.test.log)：**1 文件 / 3 tests / 46 Bun expect / 0 fail / 0 skip，含 Completed**。动态计数仅为 a66f 本轮最终执行；被引用的既有测试/E2E 没有重跑，也不计入本轮。相关 `useBucketOverrides`、`switchActiveModel`、`transcripts`、`modelSwitchRun`、`ModelPill`、`ChatSession` 在 `84740d56..a66f4ef2` 的差异为空，尚不以此替代另一个基线的动态结果；root 将负责便携复跑。

第一项观察：

- A 保存后只有 `{project-a::session-a: fixture-alpha}`；B 随后保存后只有 `{project-b::session-b: fixture-beta}`。两个活 root 当时分别仍显示 alpha/beta。
- A 卸载再挂载后，真实偏好 hook 只读到 B 项，A 的实际选择表达式得到 `fixture-default`。
- 实际 `runAfterModelSwitch()` 接收到该 fallback 后，将 `model: fixture-default` 交给记录 run 参数的适配器。该辅助函数没有真实执行 Engine；此项是未来提交参数证据。生产 [useRunController.ts:206](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useRunController.ts:206)、[同文件:403](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useRunController.ts:403)、[同文件:454](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useRunController.ts:454) 也用该 override/default lookup 并随 run 发送，所以并非只丢一处不参与发送的标签。
- A 再经选择器选 alpha 后，projection 恢复 A+B。[observations.json](/tmp/codeshell-review-20261012-model-switch-round18/observations.json) 保存这些结果并明确 `nativeElectron:false / actualModelRun:false`。

第二项正常对照：同一窗口先在 A 选 alpha，再切 B 选 beta，保存 A+B；重挂两者仍保留。另一个窗口在第一次写完之后才打开，读到最新图，修改 B 时保留 A。说明候选依赖 **另一活窗口仍持有较旧的 map**，不是所有模型修改都会丢选择。

恢复可经重新选择丢失的模型完成；若旧 B 继续使用其旧整图，后续再写仍可能覆盖 A。关闭旧窗口、在单窗重新选择后再打开它，可以避开这一次旧 snapshot；本轮第二项验证晚打开窗口读取最新图并保留已有 A。它不能保证未来多个活窗口再次修改时已消除该根因。

不声称已执行任务被改模型、真正 provider 请求使用错模型、费用变化、聊天内容丢失、权限越界或 Electron 完整复现。重开后 UI 也显示 fallback，可以重新选择恢复。故建议 **P3 偏好保存流程缺陷**，不升为 P2。permission/goal 虽共用 hook，本轮没有动态测试，不扩成额外正式影响。

### 去重与修复边界

- **R25** 是两个 Hub 默认模型表单写服务端整个 settings 字段，回滚另一个表单未改字段。M18-1 是 Desktop 不同 session bucket 的 renderer 偏好 projection，成功选择后旧窗口整图写 localStorage；修改 Hub 配置 API/表单不解决此处。
- **R61** 是共享 project catalog 中的 `activeSessionId` 被当作各窗口导航。M18-1 使用不同项目避免其触发，丢的是 `codeshell.overrides.model`，需改 `useBucketOverrides/saveOverrideMap` 的持久化契约，不是分离 active selection 即可修复。
- **R28/R29/R66** 分别为插件初始化快照、启动项目迁移、external CLI takeover 的真实权限实例；本项无这些条件或修复点。

修复应让不同窗口按目标 bucket 提交字段变化，并有统一的偏好 authority/合并与跨窗口投影更新；也可设计逐 bucket 存储键，明确删除和迁移语义。仅增加 `storage` listener 可能缓解顺序操作，不能消除两个旧整图近同时提交的覆盖。须保留现有 transient draft/Quick Chat 过滤、旧 model key 正规化、显式删除及默认模型跟随语义，避免把整个旧 map 当作删除其他窗口偏好的授权。回归应包含已有 bucket 改值、不同 bucket 添加/删除、重载、顺序新窗，以及同窗和 ephemeral 排除正常对照。

## 已检查但不另列的模型/预设边界

| 路径 | 保护或收窄结论 | 证据强度 |
| --- | --- | --- |
| 切 A→B 后 A configure 拒绝迟到 | `switchActiveModel` 的 error 分支仅记录闭包中的 A session/model，没有再写 model map 或当前选择。第三项实际组件测试使请求 pending、切 B、拒绝 A，B 仍为 default，A 的 intent 可在回来后再次用于 run 参数 | 本轮动态，Main/configure 记录替身；不宣称真实 worker offline E2E |
| Cold/已回收 session、configure 未发送成功 | [Main agent-bridge.ts:745](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:745) 仅 run 可触发 worker；[Core server.ts:3018](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:3018) 对不存在 session configure 明确 OK，下一次 run 创建。`modelSwitchRun.ts:9` 直接随 run 提交 model，故保留选择意图本身不证明后续会用旧模型 | 源码 + 本轮第三项参数控制 + 既有 `modelSwitchRun.test.ts` 源码，既有测试未重跑 |
| busy/compacting 时改模型 | `ChatView.tsx:838,2069` 禁用入口按钮；本轮第二项检查真实 ModelPill disabled。已展开的菜单在 busy 后没有同样禁用所有 option，不能声称 renderer 无任何 mid-run switch；但 Core `ChatSession.requestModelSwitch:418` 会校验并延迟到 run boundary，`pump:574`/`runExclusive:249` 再应用并 drain，避免直接更换活 LLM 客户端 | UI 接线与 Core 源码；已读 `chat-session-model.test.ts`、manager lifecycle model/exclusive 正常测试，未重跑，不另列静态竞态 |
| 排队输入 | Desktop native busy queue 优先 steer；剩余队列在 idle 后进入同一 `send` 并带当前 bucket 模型（`useRunController.ts:664,767`）。仅从 Core 可连续收到不同 model 的 FIFO 请求，不能推出正常 Desktop UI 已可达一个具体错误交错 | 源码反证；未运行任务，不把协议任意调用当 UI 缺陷 |
| per-session switch 改全局默认 | Core `ChatSession.applyModelSwitch:441` 明确 `{persist:false}`。运行中切换也经此路径；不会仅因 per-session configure 把磁盘全局 defaults.text 改掉 | 源码 + 既有 `chat-session-model.test.ts` 正常测试源码，未重跑 |
| 原生 model configure JSON-RPC error 反馈 | preload `configure:779` 返回原始 envelope；picker catch 只接 Promise reject，不解包 RPC error。若随后 run 出早期错误，原生回包反馈契约已由 **R06/D1** 覆盖。本轮未把相同错误处理再次单列，也不由此泛化成后续必用旧模型 | 源码去重，R06 原证据；没有新的 Core 拒绝动态用例 |
| Settings 当前/后台默认模型失败恢复 | `useModelConnections.setDefaultInstance:348` 等待 persist 成功才 setDefault；`setAux:197` 同样先写后改。读取有 scope/generation，pending/加载 fieldset 门禁；既有 Electron 日志 13–14 明确失败保留/回退、重试及字段保留 | 既有 [model-settings-e2e.log](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/validation/model-settings-e2e.log)，本轮未重跑 |
| “预设 picker”的实际产品入口 | 没有找到 Desktop composer 的 agent preset 切换器；preload `configure` 公开参数也无 preset。正式可编辑 `modelPresets` 是 provider catalog 的模型模板：`ConnectionInstanceCard.tsx:97` 选择 inst.model 草稿，ModelCatalogPanel 的 preset 编辑修改 draft 后显式 Save。catalog save `:214` 检查 ok、失败保留 draft 并显示 mutationError，现有 E2E 覆盖失败/取消/重试 | 产品源码 + 既有 E2E。不能把 Core preset 参数、数字人初始化的 basePreset、或旧 TODO 当作已存在 Desktop active-preset 入口 |

## 复跑、计数与清理

在仓库根目录执行：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-model-switch-round18/model-preferences.test.tsx
```

脚本用 `process.cwd()` 解析仓库，检查 guarded HOME，在产品导入前安装精确 `http://127.0.0.1:9` guard，并另外拒绝 net/tls；没有连接该端口，也没有 Core/Host 创建。共享 storage 仅为内存 fixture。`afterEach` await `act` 卸载所有 owned roots，移除 containers、清理 rAF timers；没有子进程或系统资源。JSON 仅写同一 `/tmp` 证据目录。

三个早期 harness 失败单独保留，**不计为产品问题或最终通过测试**：`model-preferences.harness-failed.log` 是 `/tmp` 自身 JSX runtime 模块定位；`geometry-harness-failed.log` 是 mini DOM 缺少 `getBoundingClientRect`；`cleanup-harness-failed.log` 是 mini DOM 缺少 `container.remove()`（同时记录未提供尺寸导致的 NaN warning）。已只修改临时 fixture，改用 createElement、提供固定几何并用 parent.removeChild 清理。最终日志没有这些 warning/失败。

Completed：本轮最终 a66f **3 tests / 46 expect / 0 fail / 0 skip**；一个 P3 候选，未编号；已检查边界不新增正式问题。主报告及产品未写入。
