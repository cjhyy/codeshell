# CCRoomView 对齐支持 Codex(含历史会话发现)+ 删除 RoomsPanel 死代码

日期：2026-06-29
状态：待实现

## 背景与问题

桌面端「房间」面板(PanelArea 里的 Bot 图标，`kind: "ccRoom"`)渲染的是
`CCRoomView`。该组件全程写死 Claude：探测 `claude` CLI、扫 `~/.claude` 历史会话、
开会话时不传 kind。用户因此在桌面端**看不到 Codex 选项**。

Codex 接入(commit `ecee37b5`)只给了**死代码** `RoomsPanel`(`window.codeshell.rooms.*`，
带 Claude/Codex 切换)一个 toggle —— 但 `RoomsPanel` 从未挂进 `PanelArea`，桌面端无入口，
手机端也不用它（`mobile/App.tsx`：「No rooms」）。

后端 `RoomManager` 已原生支持 codex：`RoomKind = "claude-code" | "codex"`，工厂按 kind
分流到 `CodexRoomAgent`，渲染共用 `ResidentAgentEvent`（codex JSONL 经 `parseCodexJsonLine`
归一），两端零改。`probeCodexCli` 在 core 也已存在。**堵点全在 `ccRoom` 这条链写死 claude。**

### 已实测的关键事实

- codeshell 驱动的 codex 命令是裸 `"codex"`（`main/index.ts:357`）。
- codex 会话源真实存在：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，首行
  `session_meta.payload` 带 `{ id, cwd, timestamp }`（`id` 即 thread_id）。本机 107 个文件。
- claude 的 `discoverSessions`（`core/src/cc-orchestrator/session-discovery.ts`）按
  `~/.claude/projects/<encodeCwd>/<sid>.jsonl` 发现；codex 是按**日期**分目录、不按 cwd —— 存储
  模型不同，需为 codex 单独写发现器（但返回同一 `DiscoveredSession` 形状）。
- `ccRoom.*` 与 `rooms.*` 是**同一个** `roomManager` 的两组 IPC 入口（`ccRoom:openSession`
  → `roomManager.openForSession`）。
- `openForSession` 当前不接受 kind，内部 `createRoom` 恒为默认 `"claude-code"`。

## 目标

1. `CCRoomView` 增加 `Claude Code | Codex` CLI 切换；按所选 kind 探测对应 CLI、列对应历史会话、
   开对应 kind 的房间。
2. 新增 codex 历史会话发现（对齐 claude 的发现体验）。
3. 保留「新开 session」入口，对 codex 即开一个空 thread 的新 codex 房间。
4. 删除死代码 `RoomsPanel.tsx` 及其独占的 `panels.rooms.*` i18n key。

## 非目标（YAGNI）

- **不删** `rooms.*` RPC / `rooms:*` main handler / `RoomPublic` / `RoomMessageWire` 类型 ——
  它们被手机端 `useRemoteApp` 数据管线、`CCConversationView`、main、preload types 共用，删了
  砸手机端且收益为零。
- 不动手机端（手机端继续按现有方式消费 rooms 数据，不引入 codex 房间 UI）。
- 不动 `RoomManager` / `CodexRoomAgent` / `parseCodexJsonLine` 的核心逻辑（已通）。

## 设计（四块改动，core → renderer）

### ① core：新增 codex 会话发现器

文件：`packages/core/src/cc-orchestrator/codex-session-discovery.ts`（并排新文件，不污染
claude 的 `session-discovery.ts`）。

```
discoverCodexSessions(cwd: string, codexHome = ~/.codex): DiscoveredSession[]
```

- 扫 `<codexHome>/sessions/`（递归 YYYY/MM/DD），对每个 `rollout-*.jsonl`：
  - 只读**首行** `session_meta`，解析 `payload.{id, cwd, timestamp}`；`cwd !== 目标 cwd` 直接跳过
    （省去读整文件）。
  - 命中后再向后读到**第一条*真实* user 消息**作 `firstMessage`。已实测 codex user 消息结构：
    `{type:"response_item", payload:{type:"message", role:"user", content:[{type:"input_text", text}]}}`。
    **必须跳过包裹噪声**：首条 user 消息常是 `<environment_context>...` 注入（类比 claude 版跳过
    `<local-command-caveat>`/`<command-name>`）；取第一条不以 `<environment_context>` 等标签开头的真实文本，读到即停。
  - `sessionId` = `payload.id`（thread_id）；`lastModified` = 文件 mtime；`messageCount` =
    用户消息计数（可只在轻量扫描时近似，或省略精确计数 → 先给 mtime + firstMessage 够用，
    messageCount 若代价高可填 0 并在测试里标注）。
- 按 `lastModified` 降序。
- 复用现成 `probeCodexCli`（无需新写探测）。

性能：codex rollout 文件可能很大，**禁止 readFileSync 整文件**；用按行流式读，命中 cwd 后只续读到
第一条 user 消息。这是与 claude 版（readFileSync）的有意差异，写进注释。

测试：`codex-session-discovery.test.ts` —— 造临时 `<tmp>/sessions/2026/06/29/rollout-*.jsonl`
（含/不含目标 cwd、坏行、空文件），验证 cwd 过滤、排序、firstMessage 提取、坏行跳过。

### ② preload + main：暴露 codex 的 RPC，openSession 透传 kind

preload（`ccRoom` 下新增两项，`openSession` 加可选 kind）：

```
ccRoom.codexProbe(force?)                         -> ipc "ccRoom:codexProbe"
ccRoom.listCodexSessions(cwd)                     -> ipc "ccRoom:listCodexSessions"
ccRoom.openSession(sessionId, cwd, mode, kind?)   -> ipc "ccRoom:openSession" (加 kind)
```

main（`index.ts`）：

```
ipcMain.handle("ccRoom:codexProbe", (_e, force) => probeCodexCli(Boolean(force)))
ipcMain.handle("ccRoom:listCodexSessions", (_e, cwd) => discoverCodexSessions(cwd))
// openSession handler 末参加 kind，透传给 roomManager.openForSession(..., kind)
```

### ③ RoomManager.openForSession 接受 kind

`packages/desktop/src/main/mobile-remote/room-manager.ts`：

```
openForSession(claudeSessionId, cwd, mode, kind: RoomKind = "claude-code")
```

- `createRoom` 时把 kind 传下去（当前根因：恒为默认 claude）。
- **跨 kind 防误复用（真坑）**：现按 `claudeSessionId` 找已存在 room 复用。codex thread_id 与
  claude session_id 同存 `claudeSessionId` 字段，理论上可能撞值。复用匹配条件加上
  `r.kind === kind`，避免拿 claude room 当 codex room 复用。

测试：`room-manager` 加 kind 透传 + 跨 kind 不误复用的回归用例。

### ④ CCRoomView 加 CLI 切换

`packages/desktop/src/renderer/cc-room/CCRoomView.tsx`：

- 新增 `const [cliKind, setCliKind] = useState<"claude-code" | "codex">("claude-code")`，顶部用
  shadcn Button 组做切换（对齐 `RoomsPanel` 原 toggle 的视觉）。
- probe：claude → `ccRoom.probe()`；codex → `ccRoom.codexProbe()`。切 kind 时重新 probe。
- listSessions：claude → `listSessions(cwd)`；codex → `listCodexSessions(cwd)`。
- openSession：透传 `cliKind` 作 kind。
- 「新开 session」对 codex：`openSession("", cwd, mode, "codex")`（空 thread = 新建）。
- 所有写死「Claude Code」的文案（加载/门控/标题/空状态）改为按 kind 取对应文案。门控未装时提示
  对应 CLI（`claude` / `codex`）。
- 对话渲染不变：仍委托 `CCConversationView`（已 CLI 无关）。

### ⑤ 删除 RoomsPanel 死代码

- 删 `packages/desktop/src/renderer/panels/RoomsPanel.tsx`（无任何 import 它的消费者）。
- 删 `i18n/ns/panels.ts` 中 `rooms.*` 子树（zh + en 两边，记忆 desktop_i18n：TranslationKey 从
  zh 推导）。已 grep 确认无其他引用、无动态拼 key。
- 保留 `rooms.*` RPC / `rooms:*` handler / 相关类型（见非目标）。

## 数据流

```
CCRoomView (cliKind=codex)
  → ccRoom.codexProbe()              → main → probeCodexCli()         [门控]
  → ccRoom.listCodexSessions(cwd)    → main → discoverCodexSessions() [列表]
  → ccRoom.openSession(id,cwd,mode,"codex")
        → roomManager.openForSession(id,cwd,mode,"codex")
        → createRoom({kind:"codex"}) → CodexRoomAgent
  → CCConversationView(roomId)       → ccRoom.send / history / onMessage
        → RoomManager 持久化 codex 事件（经 parseCodexJsonLine 归一）
        → messageMappers → streamReducer（与 claude 同一套，零改）
```

## 错误处理

- codex 未装：门控显示「未检测到 Codex CLI，请安装 codex 并确保在 PATH」+ 重新检测按钮（复用现有门控 UI，文案按 kind）。
- rollout 文件坏行/空文件/无 session_meta：发现器逐文件 try/catch 跳过，不整体崩。
- resume 失败（codex 报 `no rollout found for thread id`）：已由 `CodexRoomAgent` 现有逻辑作为 error 事件上报，无需新增。

## 测试策略

- core 单测：`discoverCodexSessions`（临时目录夹具）。
- main 单测：`openForSession` kind 透传 + 跨 kind 不误复用。
- 桌面 typecheck + build（desktop 有独立 `tsc --noEmit` / `vite build`，记忆 desktop_shadcn）。
- 手动冒烟：桌面切 Codex → 看到本项目 codex 历史会话 → 点进 resume 能对话 → 新开 codex 会话能对话；
  切回 Claude 行为不变；删 RoomsPanel 后桌面/手机无报错。

## 实现顺序

1. core 发现器 + 单测
2. RoomManager openForSession kind + 单测
3. preload + main RPC 接线
4. CCRoomView CLI 切换
5. 删 RoomsPanel + i18n 清理
6. typecheck/build/冒烟

走 worktree 隔离（功能开发，不动 main）。
