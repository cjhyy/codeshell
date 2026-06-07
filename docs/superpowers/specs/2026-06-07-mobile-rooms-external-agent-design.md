# 设计:手机房间 + 外部 Agent 常驻订阅(Rooms & Resident Agents)

- 日期:2026-06-07
- 状态:Draft(待用户确认)
- 范围:在已有 Mobile Web Remote 之上,新增"房间(Room)"抽象 + 常驻 stream-json 外部 agent(Claude Code / Codex),让手机能与一个持续活着的 CC 会话连续协作;消息以磁盘为权威源。
- 非范围:公网 relay、PTY 真 TUI(逐次交互式权限本期不做)、claude `--remote-control`(走 Anthropic 云,不适用局域网)。

---

## 0. 一句话

把现在"每条 /cc 临时派生、跑完即弃、无上下文"的模式,升级为可选的**房间制**:手机进一个房间 → 房间背后挂一个**常驻 Claude Code(stream-json)进程** → 手机消息经磁盘信箱喂给它 → 它持续干活、结果写回磁盘 + 推手机 → 上下文天然连续、断线不丢、多房间隔离。派生式 `/cc` 保留作轻量快捷入口。

---

## 1. 背景与动机(为什么要这个)

现有 Mobile Web Remote 的 `/cc` 是**派生式(ephemeral)**:手机发 `/cc <prompt>` → main `spawn("claude", ["-p", ...])` → 跑完进程退出。

实测/调研确认的硬约束(见 `2026-06-06-mobile-remote-control-design.md` 后续调研):
- **派生式无上下文**:每条 `/cc` 是全新进程。已用 `--continue` 缓解,但仍每次重启进程。
- **claude `/loop` 在 headless 下被过滤**,不能用它做"循环订阅"。
- **claude `--remote-control` 走 Anthropic 云 Bridge**,要 claude.ai 订阅,非局域网,不适用。
- **stream-json 常驻进程可行且上下文连续**(实测:喂"记住 42"→ 再问 → 答"42";进程不退)。
- **stream-json 模式不能逐次弹权限**给手机批,只能用 `--permission-mode` 预设。

结论:**自己用 stream-json 常驻进程 + 磁盘信箱**,是局域网手机持续协作 CC 的最佳落点。用户称之为"房间"。

---

## 2. 核心概念

### 2.1 Room(房间)

一个**房间**= 一次持续的人机协作上下文,绑定:
- 一个 **cwd**(工作目录,决定 agent 在哪个项目里干活 + 权限策略);
- 一个 **agent kind**(`claude-code` | `codex`,v1 主做 claude-code);
- 一个 **常驻 agent 进程**(房间"活着"时存在);
- 一份**磁盘消息记录**(信箱 + 历史,权威源);
- 一个 **permission 策略**(按 cwd 是否 trusted 预设)。

多个房间互相隔离:各自进程、各自上下文、各自消息文件。手机可在房间间切换。

### 2.2 派生式 /cc(保留,不变)

不进房间也能用:手机发 `/cc xxx` 仍临时派生 `claude -p`(带 `--continue`/PATH 补强/dangerous 策略,已实现)。定位:**快速问一句**,无需先启动。两种模式并存,互不影响。

---

## 3. 数据模型与磁盘布局

房间数据落盘(权威源,断线/重连/多设备不丢,延续"disk 作权威源"设计):

```
<userData>/mobile-remote/rooms/
  <roomId>/
    room.json          # 房间元数据
    messages.jsonl      # append-only 消息记录(信箱 + 历史合一)
```

**room.json:**
```jsonc
{
  "id": "room_<ts>_<rand>",
  "name": "codeshell",            // 显示名(默认取 cwd basename)
  "cwd": "/Users/admin/.../codeshell",
  "kind": "claude-code",
  "permissionMode": "default",     // default | acceptEdits | bypassPermissions
  "createdAt": 1717..., 
  "lastActiveAt": 1717...
}
```

**messages.jsonl**(每行一条,append-only):
```jsonc
{ "seq": 1, "ts": 1717..., "from": "user",      "type": "text",        "text": "看看这个仓库结构" }
{ "seq": 2, "ts": 1717..., "from": "agent",     "type": "text_delta",  "text": "这个仓库..." }
{ "seq": 3, "ts": 1717..., "from": "agent",     "type": "tool",        "tool": "Read", "summary": "package.json" }
{ "seq": 4, "ts": 1717..., "from": "agent",     "type": "turn_end",    "reason": "completed" }
{ "seq": 5, "ts": 1717..., "from": "system",    "type": "agent_exit",  "code": 0 }
```

- `seq` 单调递增(per room),手机用它做增量同步(`since=seq` 拉缺失部分,延续 snapshot 设计)。
- `from`: `user` | `agent` | `system`。
- 这就是用户说的"房间内容":手机和 agent 都读写它。

---

## 4. 架构

```
Electron Main
 ├─ RemoteHostManager (已有)            # WS 认证/转发
 ├─ RoomManager (新)                     # 房间生命周期 + 消息持久化
 │   ├─ createRoom / listRooms / closeRoom
 │   ├─ openRoom(roomId) → 起常驻 agent
 │   ├─ postMessage(roomId, userMsg) → 写盘 + 喂 agent
 │   └─ getMessages(roomId, sinceSeq)
 │
 ├─ ResidentAgentProcess (新)            # 一个常驻 stream-json claude
 │   ├─ spawn claude --print --verbose
 │   │     --input-format stream-json
 │   │     --output-format stream-json
 │   │     --permission-mode <room.permissionMode>
 │   │     (+ PATH 补强, cwd=room.cwd)
 │   ├─ stdin  ← 手机 user 消息(JSON)
 │   └─ stdout → 解析 stream-json → 写 messages.jsonl + 推手机
 │
 └─ ExternalAgentJobManager (已有)        # 派生式 /cc 仍走这里
```

**关键:房间的常驻进程复用 stream-json**,而**派生式 /cc 仍走现有 `-p` 一次性**。两套并存,RoomManager 是新增,不动现有 job manager。

---

## 5. 协议(手机 ↔ main,WS)

在现有 `MobileClientEvent` / `MobileServerEvent` 基础上扩展:

### 5.1 手机 → main(新增)
- `room.list` — 拉房间列表
- `room.create { name?, cwd?, kind?, permissionMode? }` — 建房间(cwd 默认跟随桌面当前/可选)
- `room.open { roomId }` — 进房间 + **启动常驻 agent**(若未启动)
- `room.close { roomId }` — 关房间(停常驻进程,消息保留在磁盘)
- `room.send { roomId, text }` — 在房间里发消息(写盘 + 喂 agent)
- `room.history { roomId, sinceSeq }` — 拉增量消息

### 5.2 main → 手机(新增)
- `room.list.ok { rooms: RoomPublic[] }`
- `room.opened { roomId, status: "running" | "starting" }`
- `room.message { roomId, msg }` — 实时推一条新消息(agent 输出 / 回显)
- `room.history.ok { roomId, messages, latestSeq }`
- `room.closed { roomId }`
- `room.error { roomId?, message }`

派生式 `/cc` 仍用现有 `chat.send` / 外部 agent job 事件,不变。

---

## 6. 手机端 UI(在现有基础上加"房间")

现有手机页已有:消息流、审批卡、job 卡、设备状态。新增:

- **房间抽屉/列表**:顶部"房间"入口 → 列出已有房间 + "新建房间"按钮。
- **进房间**:点一个房间 → `room.open` → 显示该房间历史消息 + 实时流;顶部显示房间名 + cwd + 权限模式 badge(dangerous 房间红色)。
- **房间内发消息**:底部输入栏发 → `room.send`;消息以气泡流渲染(复用现有渲染)。
- **快捷 /cc**(派生式)与"房间"并列,用户自己选用哪种。

> v1 仍是内联静态 HTML(`mobile-ui.ts`),不引构建。

---

## 7. 权限与安全

延续现有不变量(默认关闭、绑 LAN、配对/可信设备、未认证不可发),房间额外:

- **房间 permission 策略按 cwd 预设**(因为 stream-json 不能逐次弹):
  - cwd ∈ trustedWorkspaces 且 autoStart → `bypassPermissions`(= dangerous,房间标红 + 审计);
  - 否则 → `default`(claude 自动拒危险操作);
  - 用户建房间时可显式选,但**非可信 cwd 选 bypassPermissions 需高风险审批**(复用现有 approval 卡)。
- **审计**:房间创建、permissionMode、cwd、每条消息都落 messages.jsonl,天然可审计。
- **常驻进程生命周期**:房间 close / app 退出 / 设备 revoke → 停进程(进程组 kill,复用 killProcessGroup)。idle 超时可选关闭(省资源),消息保留磁盘。

---

## 8. 与现有代码的关系(最小侵入)

- **新增** `packages/desktop/src/main/mobile-remote/room-manager.ts`(房间 + 消息持久化)。
- **新增** `packages/desktop/src/main/mobile-remote/resident-agent.ts`(stream-json 常驻进程封装 + 解析)。
- **扩展** `types.ts` 加 room 协议事件;`remote-host-manager.ts` 路由新事件;`index.ts` 接 RoomManager;`mobile-ui.ts` 加房间 UI。
- **不动**:派生式 `/cc`、ExternalAgentJobManager、ClaudeCodeAdapter(它们继续服务快捷 `/cc`)。
- core 侧:stream-json 消息解析可放 core(可测),或先放 desktop(更快)。倾向先 desktop,跑通再抽 core。

---

## 9. 分阶段实现

**Phase 1 — 房间骨架 + 常驻进程(核心)**
- RoomManager:create/list/open/close/send/history + messages.jsonl 持久化。
- ResidentAgentProcess:stream-json 常驻 claude,stdin 喂、stdout 解析 → 写盘 + 事件。
- 单测:房间 CRUD、消息 seq 递增、stream-json 解析(用假进程/录制输出)。

**Phase 2 — WS 协议 + 手机房间 UI**
- 扩展协议事件 + remote-host 路由 + index 接线。
- 手机端房间列表/进出/历史/实时流。

**Phase 3 — 权限/审计/生命周期**
- 房间 permissionMode 策略 + 非可信 bypass 走审批;idle 关闭;app 退出清理。

**Phase 4 — 对比与打磨**
- 与派生式 `/cc` 并存,真机对比异步房间 vs 实时常驻体验。

---

## 10. 关键不变量

1. 派生式 `/cc` 保留,不被房间替代(快捷入口)。
2. 房间常驻进程用 stream-json,上下文连续。
3. 消息以磁盘 messages.jsonl 为权威源,断线/重连/多设备不丢。
4. 不做 PTY、不做 claude `--remote-control`、不做公网 relay。
5. 房间 dangerous(bypassPermissions)只在 trusted cwd 自动生效,否则需高风险审批,且标红 + 审计。
6. RemoteHost 仍只是 transport;agent 执行仍是独立进程,不在 main 里跑第二套 runtime。

---

## 11. 已确认的决策(2026-06-07,用户拍板)

1. **房间 cwd**:**手机上选目录**。桌面把可选项目列表(复用 repos/sessionIndex)经协议传给手机,手机建房间时选一个。
2. **agent 种类**:**v1 只做 claude-code 房间**。codex 后置(且机器未装 codex)。
3. **idle 自动关闭**:**不自动,手动关**。房间一直活到用户 close / app 退出 / 设备 revoke。
4. **手机首页**:**默认进现有快捷聊天**(默认 CodeShell agent + 派生式 /cc),顶部提供"房间"入口可切换进/出房间。派生式 /cc 与房间并存。
