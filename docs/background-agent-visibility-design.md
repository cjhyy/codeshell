# 后台子代理可见性 / 可靠性 / 可恢复 设计稿（A/B/C 三阶段）

状态：A+B+C 全部已实现 · 2026-06-23 · worktree `subagent-skill-plugin-namespace`

- **A**（转后台运行中状态 + 折叠驱动）：已实现，commit 31babc5d。
- **B**（agent 心跳 30s）：已实现，commit 31babc5d。
- **C**（重开显示中断子代理，只读不续跑）：已实现。用户拍板砍掉一键续跑（mimi-video 文件驱动，re-spawn 读文件更自然，且避免重复卡）。实现 = desktop `listInterruptedSubagents`（按 parentSessionId + status≠completed/cancelled + mtime stale 判中断，纯读 state.json，不碰 transcript replay）+ 重开 banner。core 未动。NOT_INTERRUPTED 语义对真实磁盘数据校验过（completed/cancelled 排除；active/model_error/aborted_streaming 在 stale 时标记）。

## 背景：三个真实问题（已从 s-mqqa4nio 日志诊断）

mimi-video 流水线每阶段都 spawn 子代理，每个都 >120s → 全部撞 `autoBgMs=120_000` 自动转后台。暴露三个问题：

1. **转后台后页面不知道还在 work**。根因：`turn_complete` reducer（desktop `types.ts:801` cleanSweep）把 `reason==="completed"` 的主 turn 里所有 `done:false` 的 agent 误标 done——但转后台的 agent 恰恰是 done:false 还在跑。被误标 done → `anyRunning=false` → AgentGroupCard 折叠 + 不显示运行中。
2. **转后台导致产出被折叠**。`AgentGroupCard` 默认折叠状态 = `useState(anyRunning)`，本意"在跑就展开、跑完才折"。但问题1 把 running 误清了 → 一律折叠。**所以问题2 是问题1 的派生**——修好运行中状态，折叠自然对。
3. **关 app 重开看不到中断**。后台 agent 跑在 worker 子进程；`asyncAgentRegistry` 是内存 Map（关了即丢）；agent 生命周期不进主 transcript（TranscriptEventType 无 agent 类型）。app `before-quit → bridge.kill()` SIGTERM worker → agent 半途中断，但重开 replay 时这 agent 像没存在过——既不显示运行中也不显示中断。

## 关键事实（已核实）

- 后台 agent 跑在 **worker 子进程**（`agent-bridge.ts`：main spawn 的 child）。
- **关单个窗口** worker 不死（`window.on("closed")` 只 detach 广播）→ agent 跑完、落产物文件 → 重开能 resume 看结果。**只有整个 app 退出**才 kill worker → 中断。
- `before-quit`（index.ts:2166）是唯一的优雅收尾钩子点。
- transcript 无 agent 生命周期事件；子代理 agent_start/end 仅 StreamEvent。
- `types.ts:172` 已有 "heartbeat" 概念注释（B 有基础）。

---

## 阶段 A：转后台「运行中」状态（解决问题 1+2，最小最稳）

**目标**：转后台的 agent 显示"运行中/转后台"样式，且这个状态驱动折叠（在跑不折）。

**改动**：
- core：`handoffToBackground` 时发新事件 `agent_backgrounded`（agentId, name, agentType）。现在转后台**不发任何状态事件**，前台只能靠 cleanSweep 瞎猜。
- core/types：StreamEvent 加 `agent_backgrounded`。
- desktop reducer：
  - 收到 `agent_backgrounded` → 把该 agent 标成新态 `backgrounded`（= 仍 working，NOT done）。
  - `turn_complete` cleanSweep：**跳过 `backgrounded` 的 agent**（只清真孤儿）。这是问题1 的正解——区分"孤儿(agent_end丢)"和"已转后台仍在跑"。
- desktop 渲染：
  - AgentMessageView / 卡片：`backgrounded` 显示"转后台 · 运行中"样式（区别于 running 的同步在跑、done 的完成）。
  - `summarizeAgentGroup`：`backgrounded` 计入 `running`/`anyRunning` → AgentGroupCard 默认展开（问题2 自动解决）。
- `background_agent_completed` / `agent_end` 到达时：`backgrounded` → `done`，正常收尾。

**复杂度**：小。**风险**：低（加一个状态，不动 transcript）。**对应**：问题1、问题2。

---

## 阶段 B：agent 心跳（复用现有 `Heartbeat` 类）

**决策（用户拍板用心跳）**：用**agent 级**心跳。理由——心跳比 mtime 在 LLM 长请求场景更准：实测同一 agent 两次事件最大间隔 **469s（~7.8min）**（LLM 长请求期事件流静默）。mtime 在这段会"假死"误判；worker 知道"agent 发起了 LLM 请求还没返回"，能如实报"仍在跑"。

**关键发现：心跳基础设施已存在——`packages/core/src/run/Heartbeat.ts`。** 不从零造，直接复用。它已做对全部要点：
- `start(id)`/`stop(id)`/`stopAll()`：timer 存 Map + 配对 clearInterval + `timer.unref()`（不阻止进程退出）——**防 setInterval 泄漏的教科书实现**，正面回应"会不会内存泄漏"：不会，照这个范式。
- 落盘 `{pid, timestamp}` → 供重开判 liveness。
- `isStale(id, threshold)`：时间戳超阈值（默认 `intervalMs*3`）。
- **`isProcessAlive(id)`：`process.kill(pid, 0)` 直接探进程死活** —— 突然断掉（崩溃/kill -9）→ 进程没了 → 立即 false，不用等阈值。这是"突然断掉能分辨吗"的最干净答案。

**配置（用户拍板）**：agent 心跳 **间隔 30s**。
- 失联判定 = `isStale` 默认 `intervalMs*3` = **90s**（进程活着但卡住不写心跳的兜底）。
- 但**突然断掉不用等 90s**：`isProcessAlive` 立即识别进程死亡。90s 只兜"进程活着但僵住"的少见情况。
- 独立实例：现有 `Heartbeat` 只在 `RunManager` 用（5s，run 用途）。agent 心跳**另 new 一个实例**（30s，独立 dir/用途），不影响 run 那边的 5s。

**机制**：
- worker 在 agent 转后台（handoffToBackground）时 `heartbeat.start(agentId)`，完成/失败/取消时 `heartbeat.stop(agentId)`。worker `exit` 时 `stopAll()`（graceful），非 graceful 死亡靠 isProcessAlive 兜。
- 前台感知"还在 work"：worker 仍可周期发一个 `agent_heartbeat` StreamEvent（带在跑 agentIds），或前台轮询心跳文件。倾向发事件（前台不读 worker 的盘）：worker 每 30s 扫在跑 agent 发 `agent_heartbeat { agentIds, ts }`，走现有 `server.notify(StreamEvent)`。无 running agent 不发（不空转）。

**已知限制**：`asyncAgentRegistry` 只登记 background/转后台的 agent；同步子代理转后台前的 120s 不在内。但转后台后就进了，正好覆盖 A 的 backgrounded 段（用户看不到的空窗）。

**复杂度**：小（复用 Heartbeat + 接 start/stop + 一个事件）。**风险**：低（Heartbeat 已生产验证、防泄漏到位）。**对应**：你要的"心跳知道还在 work" + "突然断掉能分辨"（isProcessAlive）+ "30s 间隔"。依赖 A。是 C 的前提。

---

## 阶段 C：后台 agent 落盘 + 重开 replay 出「中断」（最大，高危区）

**目标**：app 退出/worker 死导致 agent 半途中断后，重开 session 能看到"上次有个 agent 跑了一半被中断"。

**改动**（这是中型独立特性，碰 transcript replay 高危区）：
### C 的现状盘点（核实后大幅简化——原判"大/高危"被推翻）

查实际落盘数据（s-mqqa4nio 的子代理）：**C 需要的地基大半已存在**，因为 send_input 那轮顺带把它们建好了：

| C 需要的 | 现状 |
|---|---|
| 中断 agent 完整记忆 + 续跑 | ✅ **已有**——send_input：agent_id===childSid，session 落 `sessions/<agentId>/`，resume 带记忆续跑 |
| 列出某 session 下的子代理 | ✅ **已有**——子代理 state.json 带 `parentSessionId`（指向主 session）；`listForSession` + 扫 sessions 目录按 parent 过滤 |
| 区分完成 / 未完成 | 🟡 **半有**——state.json 已有 `status` 字段。实测：跑完的 = `completed`，没收尾的 = 停在 `active`（如 zNTH7ouA turnCount=4 卡 active）。但"中断"语义未显式写，靠"active 但无进程在跑"间接推断 |

**所以 C 不需要 C1（新增 transcript agent_lifecycle 事件 + replay 重建）那套高危改造。** 走轻量路线：

- **C-轻 改动**：
  1. **显式中断标记**：`before-quit`（index.ts:2166）kill worker 前、worker `exit` 异常时，把名下还在跑的子代理 session `status` 写成 `interrupted`（现在停在模糊的 `active`）。
  2. **重开列出**：打开 session 时，扫该 session 的子代理（按 parentSessionId），把 `status != completed` 的列成"上次中断·未完成"卡片（不依赖 transcript replay 重建，直接读 state.json）。
  3. **一键续跑**：卡片点击 → `AgentSendInput(agent_id, "继续")`（agent_id = 子代理 sid，已落盘，直接可 resume）。

- **复杂度**：中（原判大）。**风险**：中（原判高）——因为**绕开了 transcript replay 重建子代理**这个高危区（你记忆 `project_subagent_card_stuck_working` / `project_replay_empty_assistant_blocks` 的坑），改用"读 state.json status"独立通道。
- **对应**：你问的"重开能看到打断吗"——能，且能一键续上。

**闭环**：send_input（续跑能力）+ parentSessionId（列出）+ status:interrupted（标中断）= "看到中断 + 一键续跑"。三块里前两块已是现成，C-轻只补"显式标 interrupted"和"重开列出未完成"两个接线。

### ⚠️ 关键修正：突然断掉（崩溃/断电/kill -9）无法靠 status 分辨 → B 成为 C 的前提

核实：`status` 字段只有 `completed`（跑完）和 `active`（其它一切）两态。`create`/`resume` 都写 `active`，**没有任何 stale 检测**。`before-quit` 标 interrupted **只覆盖优雅退出**。

**突然断掉**（app 崩溃 / 断电 / `kill -9` / OOM）不触发 `before-quit` → status 永远停在 `active` → 与"此刻真在跑"**无法区分**。单靠状态字段分辨不出来。

正解 = **liveness 判定（活性检测），靠时间戳不靠状态**：
1. 跑着的 worker 周期性写 `lastHeartbeat` 时间戳（方案 B 的心跳，落进 session state 或独立文件）。
2. 重开时判定：
   - `completed` → 完成 ✅
   - `active` 且 `now − lastHeartbeat < 阈值`（如 30s）→ **真还在跑**（别的窗口/进程）
   - `active` 且 `now − lastHeartbeat > 阈值` → **已死**（崩溃/断电/kill，没人收尾但心跳停了能看出）→ 显示"上次中断·可续跑"

**依赖关系修正**：原把 B 列为"可选健壮性"。错。**C 要可靠分辨"突然断掉"，必须依赖 B 的心跳时间戳**——graceful 钩子覆盖不了非 graceful 死亡，唯一可靠信号是"心跳停了多久"。

现状缺口：transcript 事件无 ts（实测 turn_boundary 的 ts=None），state.json 无 lastHeartbeat。所以连"最后活动时间"都还没有，B 要先把它建起来。

**新依赖链**：A（独立）→ B（心跳 + lastHeartbeat 落盘，C 的前提）→ C（liveness 判定 + 列出 + 续跑）。

---

## 实施顺序与拍板点

1. **A 先做**（小稳，解决日常体感的问题1+2）→ TDD + 真机验。
2. **B 次之**（A 的状态上加心跳健壮性）。
3. **C 单独立项**（高危，碰 replay，值得 A/B 落定、状态模型稳了再动）。

每阶段独立 commit，A 完成可单独合 main 先用上。

待确认：
- A 的 `backgrounded` 样式具体长啥样（文案/图标）——可先用"转后台 · 运行中"占位，UI 细节你定。
- C 选 C1（transcript 事件）还是 C2（registry 落盘）——倾向 C1，到 C 阶段再细化。
