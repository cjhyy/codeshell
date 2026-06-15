# 设计稿：持久 Goal（CC 式）+ goal 消息标识 + 状态面板（2026-06-15）

> 起因：用户反馈 goal「停了就没了、新 goal 覆盖老 goal、发完想看不到当前 goal」。决策：改成 **CC 式持久 goal**。

---

## 一、现状（已实测 main `f510b838`）

**goal 是「逐消息、单发即弃」，从不落盘。**

- **core**：`engine.ts:1800` 只读 `options?.goal ?? this.config.goal`，不读 session state；`1802-1808` 每 run 临时挂裁判 hook，`finally`(1957) 跑完 unregister。goal 不存 session、不落盘。
- **desktop**：`App.tsx:1517` `if (goalEnabled && text.trim()) opts.goal = text;` —— goalEnabled 开着时，每条消息文本本身 = 该条 goal。`goalOverrides` 按 bucket 存（line 276/314/475），但没有「当前 active goal」这个持续状态。

**对照 CC `/goal`（已查证）**：
- 持久：设一次存 session，跨消息、**跨手动打断**都在。
- 清除：`/goal clear`（别名 stop/off/reset/none/cancel）或 `/clear` 或达成。
- 打断（Esc/Ctrl+C）**不清 goal**，只停执行；下条消息仍在该 goal 下跑。
- session 结束后 `--resume/--continue` 会恢复 goal（条件保留，turn/timer/token 基线重置）。
- UI：`◎ /goal active` 指示器；`/goal` 无参看状态（条件/时长/轮数/token/裁判最近 reason）。

---

## 二、目标行为（用户拍板）

1. **CC 式持久 goal**：设一次 → 存 session → 跨消息/打断存活 → 达成或手动清除才灭。
2. **新 goal 覆盖旧**：同时只一个 active goal；set 新的替换旧的（提示「已替换原 goal」）。
3. **打断不清 goal**：手动停止只停当前执行，goal 还在（对齐 CC）。
4. **goal 消息视觉标识**：发出的 goal 消息在气泡/卡片上加标记（◎ 图标 + 边框/底色），一眼识别。
5. **状态面板展示 + 清除**：复用 TopBar 右上角状态点的 hover 面板（`StatusPopover`），有 active goal 时展示当前 goal 全文 + 进度（轮数），并提供「清除 goal」按钮。

> 注：用户最初提过「发完自动关」，但确认要 CC 式持久后此项作废——goal 持续期间输入框开关代表「当前有 active goal」，不自动关；清除靠面板按钮或手动关。

---

## 三、core 改造（持久化 goal）

### 3.1 goal 存进 session state
`session state` 加字段 `activeGoal?: GoalConfig`（连同设置时间/起始 turn 基线）。
- `engine.run` 取 goal 优先级改为：`options?.goal ?? session.state.activeGoal ?? this.config.goal`。
- 当 `options.goal` 传入且与 session.activeGoal 不同 → **覆盖**写入 `session.state.activeGoal` 并 saveState（新 goal 覆盖旧，发事件 `goal_set`/`goal_replaced`）。
- goal 达成（judge met）→ 清 `session.state.activeGoal` + saveState + 事件 `goal_progress(met)`（已有）。

### 3.2 清除接口
新增协议方法 `agent/goalClear`（类比已有 `agent/goalExtend`）：
- 清 `session.state.activeGoal` + saveState + 事件 `goal_cleared`。
- desktop 经 `window.codeshell.goalClear(sessionId)` 调。

### 3.3 打断不清 goal
确认现有 abort 路径**不**碰 `session.state.activeGoal`（abort 只停 turn-loop）。下条消息 `engine.run` 仍从 `session.state.activeGoal` 取到 → 自动续 goal。需测试覆盖：set goal → abort → 再 send（不带 goal）→ 断言仍在 goal 下跑。

### 3.4 hook 注册改为「session 有 activeGoal 就挂」
`engine.ts:1802` 的条件从 `if (normalizedGoal && ...)` 改为 `if (resolvedGoal && ...)`，其中 `resolvedGoal = options?.goal ?? session.state.activeGoal ?? config.goal`。`finally` 仍 unregister（per-run 注册不变，只是来源变持久）。

### 3.5 resume 恢复
session 加载时 `activeGoal` 自然随 state 恢复（已落盘）。对齐 CC：恢复条件，但 turn/token 基线重置（设 goal 时记的基线在 resume 时刷新）。

### 测试（TDD）
- session state 序列化/反序列化带 activeGoal。
- `run` 不传 goal 但 session 有 activeGoal → judge 被调、续跑。
- 传新 goal → 覆盖 session.activeGoal + 发 goal_replaced。
- judge met → 清 activeGoal。
- goalClear → 清 + 事件。
- abort 不清 activeGoal（set→abort→send 仍在 goal 下）。

### 风险
- goal loop 是核心。改 goal 来源（per-run → 持久）要确保**不传 goal 也能续**且**判定不被旧 finalText 误判 met**。
- session state schema 变更要兼容旧 session（activeGoal 缺省 = 无 goal）。

---

## 四、desktop 改造

### 4.1 输入框 goal 开关语义
- goalEnabled 开 + 发送 → 设 active goal（`opts.goal = text`，core 落 session）。
- active goal 存在期间，开关显示「当前有 active goal」态（高亮/常亮），**不自动关**。
- 清除 goal（面板按钮）→ 开关回落。
- 多 bucket：active goal 跟 session（core 已按 session 存），desktop 订阅 `goal_set/replaced/cleared/progress(met)` 事件维护「当前 session 是否有 active goal + 文本 + 轮数」。

### 4.2 goal 消息标识（用户需求）
- 发出的 goal 消息在 MessageStream 的用户气泡上加标记：◎ 图标 + 左边框/底色（用语义 token，遵 desktop shadcn 规范，禁裸 CSS）。
- 数据来源：该 user 消息带 `isGoal` 标志（发送时打标，replay 时从 transcript 的 goal 标记恢复——需确认 transcript 是否记 goal，否则只在实时态标）。

### 4.3 状态面板展示 active goal（复用 StatusPopover）
`topbar/StatusPopover.tsx` 加一个「Goal」区块（在 Tasks 之上）：
- 有 active goal 时显示：◎ Goal 标题 + 当前 goal 全文（可滚动）+ 进度（第 N 轮 / met 状态）+ 「清除」按钮（调 goalClear）。
- TopBar 右上角状态点：有 active goal 时图标加 ◎ 角标，提示「有 active goal」。
- Props 加 `activeGoal?: { text: string; round?: number } | null` 和 `onClearGoal?: () => void`。

### 4.4 数据流
- 新事件 `goal_set/goal_replaced/goal_cleared` 加入 desktop StreamEvent 处理（types.ts reducer），维护 `activeGoalBySession`。
- `goal_progress`（已有 not_met/met/exhausted）喂轮数/met。
- App.tsx 把 activeGoal 传给 TopBar→StatusPopover；提供 onClearGoal。

### 测试
- reducer：goal_set→有 goal；goal_replaced→换文本；goal_cleared/met→清。
- StatusPopover：有 goal 渲染区块 + 清除按钮；无 goal 不渲染该区块。
- goal 消息标识渲染。

---

## 五、落地顺序
1. **core**：session state 加 activeGoal + 取值优先级 + 覆盖/清除/达成清 + goalClear 协议 + abort 不清 + 测试。rebuild core。
2. **desktop 数据流**：新事件 reducer + activeGoalBySession + goalClear 接线。
3. **desktop UI**：StatusPopover 加 Goal 区块 + TopBar 角标 + goal 消息标识 + 输入框开关语义。
4. desktop 自查 tsc + build:renderer。

---

## 六、待确认/坑
- transcript 是否记录 goal（决定 replay 后 goal 消息标识 + active goal 能否恢复）——动手前先查 `goal_mechanism_wiring` 记忆 + transcript 代码。
- 「新 goal 覆盖旧」的提示语：UI toast「已替换原 goal」。
- CC 的 `/goal clear` 别名我们不一定全做，desktop 用面板按钮即可；TUI 若要可加 `/goal` 命令（本次桌面优先，TUI 留后）。
