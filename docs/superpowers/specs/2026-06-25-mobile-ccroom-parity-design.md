# 手机遥控 cc 房间对齐桌面 — 设计稿

日期:2026-06-25
状态:已与用户确认设计,待写实现计划

## 背景与目标

手机遥控 UI(`packages/desktop/src/mobile/`,复用 desktop shadcn 的独立 React 应用)
与桌面渲染层(`packages/desktop/src/renderer/`)在会话/项目/房间的处理上有显著分歧。
本设计让手机端在四条流程上对齐桌面:

1. 新建会话
2. 切换有 cwd 的项目
3. 不同 codeshell 项目下的 session 点击
4. cc 房间 → 不同项目有不同的 cc session

用户已拍板的语义边界:

- 「cc 房间 / cc session」对齐**桌面 `CCRoomView`**,即**外部 `claude` CLI 的会话**
  (`ccRoom.*`),不是 `roomManager` 那套常驻 agent 房间的概念。
  能力要**完整对齐桌面**:发现 + 打开 + 发消息 + 审批。
- 切项目时手机**只显示该项目的 session + cc 会话**(对齐桌面 Sidebar 的「先选项目、
  再列该项目」模型)。
- 项目列表统一为**同一份真源**;桌面增删项目手机实时可见。
- 权限档(default/acceptEdits/bypassPermissions)复用桌面 `resolveRoomPermissionMode`,
  手机不引入新权限语义。

## 关键现状(已逐行核实)

### cc 房间的两个子系统其实共享运行机制

最初看像两套独立系统,核实后发现**运行机制手机已经有了**:

- **发现层**(只读文件扫描,在 core):`probeClaudeCli` / `discoverSessions` /
  `readRecentHistory`,均在 `packages/core/src/cc-orchestrator/`。手机**完全够不着**。
  - `discoverSessions(cwd)` 扫 `~/.claude/projects/<encodeCwd(cwd)>/*.jsonl`,
    返回 `DiscoveredSession[] { sessionId, firstMessage, lastModified, messageCount }`
    (`session-discovery.ts:54`)。
  - `readRecentHistory(cwd, sessionId, limit)` 返回
    `{ messages: HistoryMessage[], hasMore, totalCount }`(`session-history.ts:34`)。
- **运行层**:桌面 `ccRoom:openSession` 走的就是 `roomManager.openForSession()`
  (`room-manager.ts:201`),而手机的 `room.*` 也走**同一个** `roomManager`。
  即 open/send/approve/history-since 这套手机已有。

结论:不是造新系统,而是**给手机补一个发现层 RPC 表面 + open-by-claude-session-id**,
复用桌面已有的全部后端。

### 桌面 ccRoom IPC(渲染 ↔ 主进程)

`preload/index.ts:869-912` 暴露:probe / listSessions / openSession / send /
respondApproval / roomHistory / readHistory / closeSession,以及事件监听
`onRoomMessage`("room:message")、`onApprovalRequest`("ccRoom:approvalRequest")。

主进程 handlers 在 `main/index.ts:1910-1933`。

### 审批是广播的(用户确认的设计,非 bug)

`main/index.ts:305-314` `ApprovalBridge` 的 `onPush`:既 `webContents.send` 到所有桌面
窗口,又 `mobileRemote.broadcast({ type: "ccRoom.approvalRequest", ... })` 到所有手机。
房间消息(`onMessage`,`main/index.ts:325-332`)同样双端广播。这是 cc 房间「双端共享」
的有意设计:同一个常驻 claude 进程,任一端都能发消息/审批。

### 现存 bug:审批解决没有广播

`approval-bridge.ts:46-54` `respond()` 只 resolve parked Promise(让 claude 继续),
**没有任何「已解决」广播**。`onPush` 有广播,resolve 路径没有对应事件。后果:

- 任一端 approve → claude 继续、任务流往下走 ✅
- 但其它端(及本端其它设备)的审批卡**不会自动消失** ❌
- 唯一间接消失路径是 5 分钟超时(`approval-bridge.ts:38-40`)或那张卡所在端自己点

超时自动 deny 同样没广播,留下僵尸卡。

### 手机状态机:跟着会话走,不是选项目

`useRemoteApp.ts:511` `activeCwd = activeRoom?.cwd || activeSessionCwd`,再用
`projectContextCwd` 最长前缀匹配过滤房间(`useRemoteApp.ts:512-520`)。这是「跟着会话/
房间反推 cwd」,桌面是反过来:先选 `activeRepoId`,再列该 repo 的 session。

### 项目列表两份真源,会漂移

- 桌面:localStorage `repos`(`repos.ts`),渲染进程私有。
- 手机:服务端 `loadRecents()`(`main/index.ts:509`),磁盘。

两份各自维护。桌面删项目,磁盘 recents 还在 → 手机照看到 → 重启可能又冒出来。

### localStorage repos 的来历(为何保留而非删除)

当初放 localStorage 有真实约束,不是写错:

1. 渲染进程是 thin client(`packages/desktop/CLAUDE.md`:不 import core,只走
   `window.codeshell.*`),localStorage 是渲染进程本地最省事的同步存储。
2. pin/排序最初被当成「纯 UI 偏好」,放渲染进程合理;后来手机遥控让「有哪些项目」
   从 UI 偏好升级成两端共享的业务事实,选址才过时。
3. 「磁盘是唯一 truth」原则(见 disk_authoritative_recovery)是后来才确立的,
   localStorage repos 写在它之前。

因此本次是**架构归位**:localStorage 当初解决的「渲染端快速读取项目列表」需求依然
存在,所以 localStorage **不删,降级为磁盘 recents 的只读投影缓存**。

## 设计

### 第 1 段:手机 ccRoom RPC 表面 + 审批解决广播

#### 新增 RPC(`mobile-remote/types.ts`)

`MobileClientEvent` 新增:

- `{ type: "ccRoom.probe"; force?: boolean }`
- `{ type: "ccRoom.listSessions"; cwd: string }`
- `{ type: "ccRoom.openSession"; sessionId: string; cwd: string; mode: PermissionMode }`
- `{ type: "ccRoom.readHistory"; cwd: string; sessionId: string; limit: number }`
- `{ type: "ccRoom.respondApproval"; roomId: string; requestId: string; decision: ApprovalDecision }`

`MobileServerEvent` 新增:

- `{ type: "ccRoom.probe.ok"; available: boolean; command?: string; version?: string; reason?: ... }`
- `{ type: "ccRoom.listSessions.ok"; cwd: string; sessions: DiscoveredSession[] }`
  — **带 cwd 回声**,防异步回包串台(见下)
- `{ type: "ccRoom.opened"; roomId: string; sessionId: string; status: "running" | "missing" }`
- `{ type: "ccRoom.readHistory.ok"; sessionId: string; messages: HistoryMessage[]; hasMore: boolean; totalCount: number }`
- `{ type: "ccRoom.approvalResolved"; roomId: string; requestId: string; decision: ApprovalDecision }`
  — **新增,修审批解决广播 bug**
- `ccRoom.approvalRequest` 已存在,复用

#### 主进程 handler

在 `handleMobileClientEvent` 加 `handleCcRoomEvent` 分支(对照现有 `handleRoomEvent`,
`main/index.ts:839`),每个 case 调用**与桌面 IPC handler 相同的函数**:

- `ccRoom.probe` → `probeClaudeCli(force)`
- `ccRoom.listSessions` → `discoverSessions(cwd)`,回包带 `cwd`
- `ccRoom.openSession` → 经 `resolveRoomPermissionMode(cwd, mode)` 降级后
  `roomManager.openForSession(sessionId, cwd, resolvedMode)`
- `ccRoom.readHistory` → `readRecentHistory(cwd, sessionId, limit)`
- `ccRoom.respondApproval` → `approvalBridge.respond(roomId, requestId, decision)`

#### 设计点

1. **cwd 回声校验**:手机切项目快,`listSessions` 异步回包可能晚到。回包带 `cwd`,
   客户端只在 `resp.cwd === activeProjectCwd` 时渲染,防旧项目列表盖到新项目。
2. **权限档复用** `resolveRoomPermissionMode`(已选):非信任工作区自动降级到 default,
   bypass 受同一套门控。手机不引入新权限语义。
3. **审批继续广播**(对齐 `main/index.ts:312` 的双端共享模型),**不**改成每设备路由。
   `ccRoom.respondApproval` 任一设备都能响应;approve-once 靠 `ApprovalBridge` 已有的
   `pending` Map + requestId 去重(`approval-bridge.ts:49` `if (!p) return false`),
   不靠设备隔离。

#### 审批解决广播(bug 修复)

- `ApprovalBridge` 加 `onResolve` 回调(对称于现有 `onPush`):
  `respond()` 成功消费 `p`(`approval-bridge.ts:46-54`)时触发,**超时自动 deny 路径
  (`approval-bridge.ts:38-40`)也走同一个 `onResolve`**,否则超时后僵尸卡仍不消。
- 主进程 `onResolve` → 同时 `mobileRemote.broadcast({ type: "ccRoom.approvalResolved", ... })`
  + `webContents.send("ccRoom:approvalResolved", ...)` 到所有桌面窗口。
- 桌面 `onApprovalRequest` 监听器侧 + 手机 `useRemoteApp` 收到 `approvalResolved`,
  按 requestId 把卡从 approvals 列表删掉。手机端 `respondApproval` 已有同款本地去重
  (`useRemoteApp.ts:444`),复用其过滤逻辑。

结果:任一端响应/超时 → 所有端那张卡同步消失 → 任务流继续。

### 第 2 段:手机引入 activeProjectCwd 一等状态

把手机从「跟着会话走」改成「选项目」,对齐桌面 `activeRepoId`。

- `useRemoteApp` 新增 `activeProjectCwd: string | null` 作为「当前选中项目」单一事实源。
- 选项目 → 设 `activeProjectCwd` → 触发三件事:
  1. `session.list`(服务端按 cwd 过滤)
  2. `ccRoom.listSessions(cwd)`
  3. `room.list`(客户端按 `projectContextCwd` 过滤,保留现有逻辑)
- **session 列表**:`SessionList`(现客户端 `groupByProject`,`format.ts`)改为只渲染
  当前 `activeProjectCwd` 那一组,其余折叠成「切换项目」入口(对齐桌面已有的
  「当前项目 / 其它项目」分区,`SessionList.tsx:64`)。
- **cc 会话**:`activeProjectCwd` 变化 → 重新 `ccRoom.listSessions`;回包用第 1 段的
  cwd 回声校验,仅 `resp.cwd === activeProjectCwd` 才渲染。
- **同项目并列两种会话源**(对齐桌面一个项目下 chat + CC Room tab):普通 chat
  session(`session.*`)与外部 claude CLI 会话(`ccRoom.*`)。

#### 顺手修 newSession 竞态

手机 `newSession` 现不等 `chat.accepted` 回包就重置状态(`useRemoteApp.ts:406`)。
改为:发 `session.create` 后,拿到 `chat.accepted` 前记「待绑定」标记,第一条
`chat.send` 用回包里的 sessionId(对齐桌面「发第一条消息才落 session」,但保留手机
服务端铸 ID 的事实)。

### 第 3 段:磁盘 recents 升为唯一 truth

符合「磁盘是唯一 truth、localStorage 仅缓存、重启可重建侧边栏」原则
(disk_authoritative_recovery)。

#### 数据结构

磁盘 recents 收编以下原 localStorage 修饰字段(用户已选,**只这两个**):

- `pinned`:置顶状态
- 软删除标记:删项目持久化、手机同步、重启不回来

**不收**手动排序和重命名:排序默认按最近使用时间;不引入自定义显示名。

#### 角色定位

- **磁盘 recents(主进程)= 唯一真源**,持有项目集合 + pinned + 软删除标记。
- **localStorage repos = 磁盘 recents 的只读投影缓存**:
  - 启动:磁盘 recents → 投影进 localStorage → Sidebar 同步渲染(不卡,不每次 IPC)
  - 写(增/删/pin):Sidebar → 主进程 IPC → 落磁盘 recents → 广播 → 桌面回灌
    localStorage 投影 + 手机刷新
  - localStorage 丢失无碍:重启从磁盘重建
- **手机**读同一份磁盘 recents 的广播,与桌面逐字段一致(pin/删除同步)。

#### 同步机制

- 主进程在项目变更(增/删/pin)后广播:
  - 给手机:`room.projects.ok`(复用现有,`main/index.ts:518`)
  - 给桌面窗口:新 IPC 事件,触发 localStorage 投影回灌
- 手机主动刷新:进入项目选择 / 切项目 / 开房间时重发 `room.projects`,修现有 stale
  (`useRemoteApp.ts:468`)。

#### 迁移

**不迁移**(用户已选):磁盘 recents 从现有项目集合重建,老用户 localStorage 里的
pin 会丢一次。简单,接受一次性体验回退。

## 不做的事(YAGNI)

- 不把手动排序 / 自定义重命名搬上磁盘(本次不收编)。
- 不写 localStorage → 磁盘的迁移逻辑。
- 不改 chat 审批(session-bound)的现有每设备隔离;只动 cc 房间审批的广播链。
- 不把 cc 房间审批改成每设备路由(保持双端共享)。

## 受影响文件(预估)

- `packages/desktop/src/main/mobile-remote/types.ts` — 两个事件 union 扩字段
- `packages/desktop/src/main/index.ts` — `handleCcRoomEvent`、审批 `onResolve` 接线、
  项目变更广播
- `packages/desktop/src/main/cc-room/approval-bridge.ts` — `onResolve` 回调
- `packages/desktop/src/mobile/hooks/useRemoteApp.ts` — `activeProjectCwd`、ccRoom
  RPC 调用、approvalResolved 消费、newSession 竞态
- `packages/desktop/src/mobile/components/SessionList.tsx` — 按 activeProjectCwd 过滤
- 手机端新增 cc 会话列表组件(对照 `renderer/cc-room/CCRoomView.tsx`)
- `packages/desktop/src/renderer/`:`repos.ts` / Sidebar 写路径改走主进程 + 投影回灌
- core recents 存储:扩 `pinned` + 软删除标记

## 待实现计划

下一步:writing-plans skill 产出实现计划。
