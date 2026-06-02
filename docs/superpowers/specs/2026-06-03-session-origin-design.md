# session origin 字段 + 侧边栏按来源过滤

日期:2026-06-03
状态:待审

## 1. 背景与问题

桌面侧边栏从 disk 重建会话时,会把**非桌面来源**的 session 一起灌进来,且丢失 automation 身份:

- **TUI session 混入桌面侧边栏**:tui(`repl`/`run`)和桌面共用同一 `~/.code-shell/sessions/`,`state.json` 无来源字段 → 无法区分,disk 重建把 tui 会话也当桌面会话显示。
- **automation session 丢 ⚙ 标志**:`source:"automation"` 只在 localStorage,disk 的 state.json 不存 → 从 disk 重建出来的 automation 会话没有 ⚙ 身份。
- 根本缺陷:**`state.json` 缺"来源/类型"元数据**,任何"从 disk 重建侧边栏"都分不清来源。

(测试污染 `~/.code-shell` 的问题已由 #23 `CODE_SHELL_HOME` 隔离解决;临时 cwd 误建项目已由 #25 isNoRepoCwd 扩展解决。本设计补最后一块:来源标识。)

## 2. 参考:Codex(本机实测)

Codex `session_meta` 带 `originator`(如 "Codex Desktop")、`source`(如 "vscode")。每个 session 记录来源,列会话按来源过滤。本设计即引入对应的 `origin` 字段。

## 3. 关键决策(已与用户逐条确认)

| 决策 | 选择 |
|---|---|
| 侧边栏显示哪些 origin | **desktop + automation**(tui 过滤掉;subagent 已靠 parentSessionId 过滤) |
| 存量 144 个无 origin 旧 session | **直接删**(用户:内容不重要,只要恢复机制正确;有 tar 备份) |
| 无 origin 的过滤规则 | 存量已删 → 规则简单:**只显示 origin ∈ {desktop, automation}**(无字段者不显示) |
| 桌面交互 origin 怎么传 | **agent-server-stdio engineFactory 固定 `origin:"desktop"`**(worker 本就桌面专用) |

**用户核心诉求**:内容找回不重要,**"清空 localStorage 后从 disk 正确恢复"这套机制要工作** —— tui 不混入、automation 带标志、desktop 正常。

## 4. 设计

### A. core:origin 字段(SessionState + EngineConfig)

- `SessionState` 加 `origin?: SessionOrigin`(types.ts);`SessionOrigin = "desktop" | "tui" | "automation" | "subagent"`。
- `EngineConfig` 加 `origin?: SessionOrigin`(engine.ts)。
- `SessionManager.create(cwd, model, provider, explicitSessionId?, parentSessionId?, origin?)` 接收并落盘(同 parentSessionId 模式:始终写,缺省 undefined/不写)。
- engine 调 create 时传 `this.config.origin`;子代理(isSubAgent)若未显式给 origin,可标 `"subagent"`(但其过滤主要靠 parentSessionId,origin 是辅助)。

### B. 各宿主传 origin

| 上下文 | 文件 | 传值 |
|---|---|---|
| 桌面交互 | `agent-server-stdio.ts` engineFactory(~164) | `origin:"desktop"` 固定 |
| tui repl/run | `tui/.../repl.ts`、`run.ts` 的 new Engine | `origin:"tui"` |
| automation | `desktop/.../automation-host.ts` 的 new Engine | `origin:"automation"` |
| 子代理 | engine.ts child.run | `origin:"subagent"`(辅助;parentSessionId 已是主判据) |

### C. renderer 过滤(disk 重建 + 侧边栏)

`listDiskSessions`(main)已读 state.json 出 `parentSessionId` 做过滤;**追加读 `origin`**,过滤规则:
- 跳过 sub-agent(parentSessionId 非空,已实现)
- **只返回 `origin === "desktop" || origin === "automation"`**;`origin` 为 tui / 缺失 → 跳过。

`DiskSessionMeta` 带上 `origin`,renderer:automation 的标 ⚙(source:"automation"),desktop 普通显示。

### D. 存量清理

删现有 144 个无 origin 的 session(内容不重要,tar 备份到 `~/.code-shell/sessions-origin-wipe-backup.tar.gz`)。恢复机制从干净状态起步,过滤规则不必照顾无字段旧会话。

## 5. 组件与改动面

- `core/types.ts`:SessionState 加 origin + SessionOrigin 类型。
- `core/engine/engine.ts`:EngineConfig 加 origin;create 调用传 origin。
- `core/session/session-manager.ts`:create 第 6 参 origin,落盘。
- `core/cli/agent-server-stdio.ts`:engineFactory 固定 origin:"desktop"。
- `tui/.../repl.ts`、`run.ts`:new Engine 传 origin:"tui"。
- `desktop/.../automation-host.ts`:new Engine 传 origin:"automation"。
- `desktop/main/sessions-service.ts`:listDiskSessions 读 origin + 按 {desktop,automation} 过滤;DiskSessionMeta 加 origin。
- 数据:删存量 144 个。

## 6. 测试

- `SessionManager.create` 写 origin(present/absent)。
- `listDiskSessions`:origin desktop/automation 显示,tui/缺失跳过,sub-agent(parentSessionId)跳过。
- engineFactory / 各宿主传对 origin(以集成/构造断言为主)。

## 7. YAGNI / 边界

- 不做 origin 的 UI 筛选器(只内部过滤)。
- 子代理过滤仍以 parentSessionId 为主,origin:"subagent" 仅辅助/调试可读性。
- 不迁移存量(直接删,内容不重要)。
- 测试隔离已由 #23 CODE_SHELL_HOME 解决,本设计不重复。
