# DriveAgent 展示区跳转到 Claude Code / Codex 会话

## 1. 问题与现状

DriveAgent 的后台任务记录已经拥有定位外部 CLI 会话所需的数据，但 UI 聚合层在组装 `BackgroundWorkEntry` 时把这些数据丢掉了。

- `packages/core/src/tool-system/builtin/background-jobs.ts:40-64` 的 `BackgroundJobEntry` 已包含 `kind`、`ccSessionId`、`cwd` 和 `cli`。DriveAgent 启动时在 `packages/core/src/tool-system/builtin/drive-claude-code.ts:436-440` 写入 `kind: "drive-agent"`、规范化后的 cwd 和 CLI；完成时在同文件 `:392-398` 写入外部会话 ID。
- `packages/core/src/tool-system/builtin/background-work.ts:84-112` 的 UI 类型只给 job 暴露状态、时间、结果和变更文件；`:202-217` 的映射同样没有复制 job kind、`ccSessionId`、`cli`、`cwd`。
- preload 还维护了两份 renderer-local 镜像类型：`packages/desktop/src/preload/index.ts:46-69` 与 `packages/desktop/src/preload/types.d.ts:60-85`，两处 job 分支也缺少上述字段。
- `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:310-379` 将后台 job 渲染为只读行；当前只可展开 `changedFiles` 和 `finalText`，没有进入外部会话的动作。

CLI room 的现有打开路径已经确认：

1. `packages/desktop/src/renderer/cc-room/CCRoomView.tsx:50-61` 目前只接收面板 cwd/active，自行维护 CLI kind、列表和当前 conversation。
2. 用户选择会话及权限模式后，`:71-83` 调用 `window.codeshell.ccRoom.openSession(sessionId, cwd, mode, cliKind)`；`:171-184` 再用返回的 `roomId` 渲染 `CCConversationView`。
3. preload 在 `packages/desktop/src/preload/index.ts:1232-1238` 将该调用转成 `ccRoom:openSession` IPC；声明位于 `packages/desktop/src/preload/types.d.ts:1376-1383`。
4. main 的 `packages/desktop/src/main/index.ts:2740-2749` 调用 `roomManager.openForSession(externalSessionId, cwd, mode, kind)`。因此真正打开一个 room 至少需要：外部 session/thread ID、cwd、CLI kind 和 permission mode。
5. DriveAgent 的 `cli` 值是 `"claude" | "codex"`（`drive-claude-code.ts:67-71`），而 room 层使用 `"claude-code" | "codex"`（`CCRoomView.tsx:31-34`）；不能直接透传，必须做显式映射。

面板导航目前由 App 的 bucket 状态统一控制：`packages/desktop/src/renderer/App.tsx:227-240` 定义临时请求状态，`:3410-3480` 已用 `codeshell:review-files`、`codeshell:open-url`、`codeshell:open-file` 事件实现“先把目标写进 bucket，再打开对应面板”。`PanelRegistry.ts:131-137` 最终创建 `CCRoomView`。本功能应沿用这条路径，避免 BackgroundShellPanel 直接操纵别的面板实例。

## 2. 目标

- 只有确认为 DriveAgent 且同时具备有效外部会话 ID、CLI kind、cwd 的任务显示“打开 Claude Code/Codex 会话”按钮。
- 点击后打开或聚焦当前任务所属 session bucket 的 `ccRoom` 面板，并直接进入对应 conversation；不要求用户先在历史列表中搜索。
- 已存在的 room 保留原 permission mode；首次从 DriveAgent 记录创建 room 时使用安全的 `default` 模式，不因“跳转查看”静默提升权限。
- Claude 与 Codex 均可跳转，且 cwd 使用任务实际运行目录，而不是当前 UI 项目目录。
- 老 worker、普通视频 job、尚未拿到外部 session ID 的运行中任务继续正常显示，不出现无效按钮。

## 3. 详细修改方案

### 3.1 Core：补全 UI-oriented job 数据

修改 `packages/core/src/tool-system/builtin/background-work.ts`：

- 在 `BackgroundWorkEntry` 的 job 分支增加：

  ```ts
  jobKind?: BackgroundJobKind;
  externalSessionId?: string;
  cli?: "claude" | "codex";
  cwd?: string;
  ```

- `BackgroundJobEntry.cli` 当前是宽泛的 `string`。优先在 `background-jobs.ts` 将其收窄为共享的 `DriveCli` 等价联合类型；若为避免 core 模块循环而不导入 DriveAgent 类型，可在 `background-jobs.ts` 本地声明 `ExternalCliKind = "claude" | "codex"` 并让 start options 复用。
- 在 `listBackgroundWorkForUI()` 的 job 映射（当前 `background-work.ts:202-217`）中：
  - `jobKind` 复制 `j.kind`；
  - `externalSessionId` 映射自历史命名 `j.ccSessionId`，UI 合同不继续扩大 CC-only 命名；
  - 仅在值合法时复制 `cli`；
  - 复制 registry 已规范化的 `cwd`。
- 不改 `listRunningBackgroundWork()` 的 judge 合同；它本来就是有意的 lossy view（`:66-72`）。

这样 renderer 可用 `jobKind === "drive-agent"` 做可靠判定，而不是从 description 或字段组合猜测任务类型。

### 3.2 Preload：同步 renderer 边界类型

同时修改以下两处，保持 contextBridge 实现和全局声明一致：

- `packages/desktop/src/preload/index.ts` 的 `BackgroundWorkInfo` job 分支；
- `packages/desktop/src/preload/types.d.ts` 的同名 job 分支。

字段名、可选性和 CLI 联合类型必须与 core 的 UI 合同一致。`listBackgroundWork()` RPC 本身返回 JSON，无需新增 RPC method 或额外 IPC channel。

兼容原则：所有新字段均为 optional。renderer 与短暂存活的旧 worker 组合运行时，拿到旧 shape 只会隐藏跳转按钮。

### 3.3 Renderer：定义一次性“打开外部会话”请求

建议新增一个 renderer-local 类型（可放在 `panels/PanelRegistry.ts` 附近的独立 `cc-room/types.ts`）：

```ts
interface OpenCliSessionRequest {
  nonce: number;
  externalSessionId: string;
  cliKind: "claude-code" | "codex";
  cwd: string;
}
```

修改 `packages/desktop/src/renderer/App.tsx`：

- 在 `PanelBucketState`（当前 `:227-237`）增加瞬态 `openCliSession?: OpenCliSessionRequest`，不把它写入 `savePanelState()` 的持久化快照；与 `openUrl` 一样用单调 nonce 支持重复点击同一任务。
- 注册 `codeshell:open-cli-session` listener，校验 detail 后选择 target bucket：
  1. 优先使用事件里的 DriveAgent owner engine session ID，通过 `engineToBucketRef.current` 找到任务所属 bucket；
  2. 找不到（例如历史 session 尚未建立反向索引）时退回 `activeBucketRef.current`，但仍使用 job 自带 cwd；
  3. 更新目标 bucket：`open: true`、`requestKind: "ccRoom"`、递增 `requestNonce`，并写入 `openCliSession`。
- `onClose` 只清除当前展示请求，不删除已经打开的 room conversation；nonce 已消费后也不应在面板 remount 时重复打开。
- 将 `openCliSession` 依次传过 `PanelArea`、`PanelBody`、`PanelRenderContext`，最终由 `PanelRegistry.ts:131-137` 交给 `CCRoomView`。

采用 App bucket 请求而非让卡片直接调用 IPC，有两个好处：能够可靠聚焦/创建 `ccRoom` tab，且跨 session 的“全部后台任务”列表不会把 room 打开到错误 dock。

### 3.4 BackgroundShellPanel：增加按钮及错误反馈

修改 `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:310-379`：

- 为 job 计算：

  ```ts
  const cliKind = j.cli === "claude" ? "claude-code" : j.cli === "codex" ? "codex" : null;
  const canOpenCli =
    j.jobKind === "drive-agent" && !!j.externalSessionId && !!j.cwd && cliKind !== null;
  ```

- 在状态文字前增加小型 external-link/terminal 按钮。按钮 `onClick` 必须 `stopPropagation()`，否则点击会同时切换结果展开状态。
- 点击时 dispatch `codeshell:open-cli-session`，detail 携带请求三元组及 `sourceSession.sessionId`。
- running job 在尚未产生 external session ID 时不显示按钮；若产品希望解释原因，可显示 disabled 图标并用 tooltip 提示“会话 ID 生成后可打开”，但不要发送空 ID。
- 新增中英文 i18n：打开 Claude Code、打开 Codex、无法打开会话/会话信息不完整。不要硬编码 UI 文案。

### 3.5 CCRoomView：消费 deep-link 并直接进入 conversation

修改 `packages/desktop/src/renderer/cc-room/CCRoomView.tsx`：

- Props 增加 `openRequest?: OpenCliSessionRequest`。
- `conv` 状态增加自己的 `cwd` 与 `cliKind`。直接跳转可能来自另一个 bucket/job cwd，不能继续用外层 `cwd` 和当前 CLI switch 的闭包值渲染历史。
- 用 `lastOpenRequestNonceRef` 去重，在 effect 中按请求执行：
  1. 切换 `cliKind`；
  2. probe 对应 CLI；不可用时显示已有的 CLI 缺失态并 toast；
  3. 调用下述 `openLinkedSession`；
  4. 以返回的 roomId/mode 和请求 cwd 设置 `conv`。
- deep-link 不打开“选择权限模式”对话框。该对话框仍保留给列表点击和“新开 session”。
- 用户从 conversation 点返回时回到面板当前项目的普通列表；清掉已消费请求不会再次跳入。

### 3.6 Main / preload：增加不会覆盖既有权限的 linked-session 打开接口

不建议 deep-link 直接复用现有 `openSession(..., "default", ...)`：`RoomManager.openForSession()` 在已有 room 的 permission mode 不同时会重启并改写 mode（`room-manager.ts:388-400`），一次查看动作不应改变既有 room 权限。

增加语义明确的接口：

```ts
ccRoom.openLinkedSession(
  externalSessionId: string,
  cwd: string,
  kind: "claude-code" | "codex",
): Promise<{ roomId: string; status: "running" | "missing"; mode: PermissionMode }>;
```

涉及文件：

- `packages/desktop/src/main/mobile-remote/room-manager.ts`：增加 `openLinkedSession()`。按 external ID + kind（并校验 cwd 绑定）查找已有 room；找到则按其持久化 mode 调用 `open()`，未找到则以 `default` 创建/打开。逻辑放在 RoomManager 内，避免 desktop IPC 与 mobile handler 各自复制查找规则。
- `packages/desktop/src/main/index.ts`：在现有 `ccRoom:openSession` 邻近注册 `ccRoom:openLinkedSession`，验证三项 string/enum 输入后调用 RoomManager。
- `packages/desktop/src/preload/index.ts` 与 `preload/types.d.ts`：暴露并声明该方法。

main 仍是最终校验边界：拒绝空 session ID、非受支持 kind 和空 cwd。RoomManager 的 transcript 订阅已有 `roomMatchesTranscript(roomId, cwd, sessionId, kind)` 校验（`main/index.ts:2751-2762`），deep-link 创建的 room 必须满足同一绑定。

## 4. 分步骤实施顺序

1. 收窄 background job CLI 类型，并在 `BackgroundWorkEntry`/mapper 中透传 `jobKind`、外部 session ID、CLI、cwd。
2. 同步 preload 两份 `BackgroundWorkInfo` 类型，补 core background-work RPC 单测。
3. 在 RoomManager/main/preload 增加 `openLinkedSession`，先把“保留已有权限、首次 default”的行为测牢。
4. 定义 `OpenCliSessionRequest`，扩展 App bucket 状态以及 PanelArea/PanelRegistry props 链。
5. 给 `CCRoomView` 增加 nonce 去重的 deep-link effect，并让 conversation 持有自己的 cwd/kind。
6. 最后在 BackgroundShellPanel 加按钮、事件 dispatch 和 i18n；此时点击链路从数据到 UI 已完整。
7. 手工检查普通 job、缺字段旧 shape、跨 session job 和重复点击同一任务。

## 5. 测试策略

### 单元测试

- 扩展 `packages/core/src/protocol/server.backgroundwork.test.ts`：注册 `kind: "drive-agent"` 的 job，完成时写 external session ID，断言 RPC 返回 `jobKind/externalSessionId/cli/cwd`；普通 video job 不伪装成 DriveAgent。
- 扩展/新增 `background-work` mapper 测试：非法或未知 CLI 不被输出成可打开 kind，registry cwd 保持规范化。
- `room-manager` 测试：
  - 首次 linked open 创建 `default` room；
  - 已有 acceptEdits/bypass room 被复用且 mode 不被覆盖、不重启；
  - 同 ID 不同 CLI 不串房；
  - cwd 不匹配时拒绝或创建独立绑定（实现前固定唯一策略）。
- `CCRoomView` 组件测试：openRequest 触发正确 kind/cwd/sessionId；同 nonce rerender 不二次调用；新 nonce 可再次聚焦；CLI probe 失败不调用 open。
- BackgroundShellPanel 组件测试：只有完整 DriveAgent 记录显示按钮；点击 detail 正确且不展开/收起结果行。
- App 面板路由测试：owner engine session 可映射时写入对应 bucket；无法映射时安全回退当前 bucket。

### 集成/手工验证

- 分别启动 Claude 与 Codex DriveAgent，等待生成 session ID 后点击按钮，确认直接进入对应 transcript。
- 在 A session 的“全部后台任务”中点击 B session 的 job，确认聚焦 B bucket，不污染 A 的 panel state。
- 对已存在的 bypassPermissions room 执行跳转，确认 room 没被重启为 default。
- 切换当前项目后点击旧任务，确认 history/read/subscribe 使用 job.cwd，而不是当前项目 cwd。
- 模拟旧 worker 返回不带新增字段的 job，确认 UI 无报错且按钮隐藏。

## 6. 风险与兼容性注意

- **CLI 枚举不一致**：DriveAgent 的 `claude` 必须映射为 room 的 `claude-code`；集中写一个纯函数并测试，禁止散落字符串判断。
- **session ID 尚未可用**：外部 CLI 可能在运行后期才报告 ID。按钮必须依赖完整字段；3 秒轮询会在 registry 更新后自然出现。
- **权限副作用**：直接调用旧 `openSession(default)` 会覆盖已有 room mode，是本方案增加 `openLinkedSession` 的主要原因。
- **cwd 是会话身份的一部分**：相同 external ID 与错误 cwd 组合会导致历史读取为空或 transcript subscription 被 main 拒绝。始终以 job registry 的 cwd 为准，并在 main 再校验。
- **跨 session 路由**：BackgroundShellPanel 以 `scope: "all"` 查询（`:54-61`），不能默认任务属于当前 bucket；必须携带 `sourceSession.sessionId`。
- **短暂的版本错配**：新增传输字段保持 optional；旧 worker/新 renderer 的安全行为是隐藏按钮。新 worker/旧 renderer 会忽略额外 JSON 字段。
- **完成任务保留窗口**：job registry 会保留 terminal jobs（`background-jobs.ts:35-37` 的上限），跳转按钮可在完成后继续使用；不要只按 running 状态显示。
