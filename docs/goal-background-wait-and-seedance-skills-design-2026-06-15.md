# 设计稿：Goal 等后台通知 + Seedance 视频 skill 优化（2026-06-15）

> 起因：session `s-mqe0ox7n-a8d11c26` 在 seedance 项目里跑视频生成时，反复「bash 之后卡住 30s 轮询」，token 烧到 537 万，15 次 aborted_streaming。

---

## 一、根因（已坐实，非猜测）

### 1.1 现象
- 你的指令「30s 查一次」被 AI 当成 goal，进入 `goal_progress` 循环 round 1→8...，每轮判 `not_met`，AI 自己 `sleep 30` + 裸调 fal GET 接口查 status。
- 工具描述里明明写了「Do NOT sleep or poll」（`generate-video.ts:84-87`），AI 仍无视。

### 1.2 真因（控制流）
代码链路：

1. `GenerateVideo` 提交后立即返回，`pollToCompletion()` 以 **detached `void` promise** 在后台跑（`generate-video.ts:300`）。**它不注册进 `asyncAgentRegistry`。**
2. 引擎 `Engine.run` 有「等后台任务再收口」的循环（`engine.ts:1889`），但它**只检查后台 sub-agent**：
   ```ts
   while (!aborted && asyncAgentRegistry.hasRunningForSession(sid)) { ... }
   ```
   视频后台任务不在 registry 里 → `hasRunningForSession()` 返回 false → **引擎不等，直接收口。**
3. 但 goal 没达成（视频还没好）→ `goal-stop-hook` 判 `not_met` → `continueSession:true`（`goal-stop-hook.ts:147`）→ turn-loop 强制再跑一轮（`turn-loop.ts:696-729`）。
4. AI 这一轮无事可做，只能等视频 → 它发明 busywork：`sleep 30` / 手动 GET 轮询 → **死循环。**

**一句话**：后台视频任务对引擎不可见 → 引擎不 park 等通知 → goal 裁判逼 AI 一直干活 → AI 只能 sleep 自旋。

### 1.3 CC/Codex 怎么做（research 结论，回答你的「有 pending 状态吗」）
- **CC 没有「阻塞 turn 完成的 pending 状态」**，恰恰相反：后台任务（`run_in_background` Bash / Monitor）**让 turn 结束、agent 让出控制权**，靠 Monitor 推送或 `ScheduleWakeup` 重新唤醒，**绝不 idle 自旋**。
- CC 的 `/goal` 裁判 = 一个独立小模型读 transcript 判完成，**把具体 reason 喂回下一轮**——这跟 codeshell 的 `goal-stop-hook` 是同一套设计。
- 防 busywork 不是「阻塞循环」，而是 **agent 用 yield（Monitor/ScheduleWakeup）替代 sleep** + 裁判给具体指引。

**结论**：codeshell 架构已经很接近 CC，缺的就是「后台视频任务可见 + 引擎据此 park 等通知」这一环。`engine.ts:1889` 的 wait-loop 已经是正确的「等后台」机制，只是视频没接进去。

---

## 二、修复方案（问题 1：引擎等通知）

### 方案 A（推荐）：让后台视频任务对引擎可见，复用现有 wait-loop

**核心思路**：视频后台 poll 期间，登记一个轻量「后台作业」计数，让 `engine.ts:1889` 的 wait-loop 把它和后台 sub-agent 一视同仁地等。

#### A.1 新增轻量后台作业追踪（不复用重量级 asyncAgentRegistry）
`asyncAgentRegistry` 的 entry 带 `abort()`/transcript/fade 等 agent 专属字段，视频任务塞进去要造假字段、且语义混淆（视频不是 agent，不该出现在 AgentStatus 列表）。

新建 `tool-system/builtin/background-jobs.ts`：
```ts
// 轻量「非 agent 的后台作业」存活计数（视频生成等）。只关心「这个 session
// 还有没有后台作业在跑」，不带 abort/transcript。
class BackgroundJobRegistry {
  private jobs = new Map<string, { sessionId: string }>();  // jobId -> meta
  start(jobId: string, sessionId: string): void { ... }
  finish(jobId: string): void { ... }
  hasRunningForSession(sessionId: string): boolean { ... }
  // 复用 asyncAgentRegistry 的 subscribe/notify 模式，让 waitForBackgroundAgentChange 能感知变化
  subscribe(cb): () => void { ... }
}
export const backgroundJobRegistry = new BackgroundJobRegistry();
```

#### A.2 GenerateVideo 在 poll 期间登记
`generate-video.ts`：
```ts
const jobKey = `video-${jobId}`;
if (sessionId) backgroundJobRegistry.start(jobKey, sessionId);
void pollToCompletion(...).finally(() => {
  if (sessionId) backgroundJobRegistry.finish(jobKey);
});
```
（`notifyVideo` 已经 enqueue 通知，不动。）

#### A.3 引擎 wait-loop 同时等两类后台
`engine.ts:1889`：
```ts
const stillRunning = () =>
  asyncAgentRegistry.hasRunningForSession(sid) ||
  backgroundJobRegistry.hasRunningForSession(sid);
while (!aborted && stillRunning()) {
  aborted = await this.waitForBackgroundChange(sid, options?.signal); // 订阅两个 registry
}
```
`waitForBackgroundAgentChange` 改名/扩展成订阅两个 registry 的变化信号（任一变化即 resolve 重查）。

#### A.4 关键交互：goal-stop-hook 必须在「等后台」之后才判
当前顺序：turn-loop 跑完 → **on_stop（goal 判定，可能 continueSession）** → 回到 engine 的 wait-loop。

问题：goal-stop-hook 在 turn-loop 内部触发（`turn-loop.ts:685`），**早于** engine 的 wait-loop（`engine.ts:1889`）。所以 goal 判 not_met → continueSession → turn-loop 又跑一轮，**根本到不了 wait-loop**。

**这是方案的难点。** 两个子方案：

- **A-i（推荐）**：goal-stop-hook 判定前，先查 `backgroundJobRegistry.hasRunningForSession`。**若有后台作业在跑，hook 直接返回「park」语义**——不调 LLM 判定、不 continueSession、让 turn 干净结束，交给 engine wait-loop 去 park 等通知。等通知回来后 engine 注入结果跑「summarize 轮」，那一轮结束再正常走 goal 判定。
  - 改动点：`goal-stop-hook.ts` 开头加 `if (backgroundJobRegistry.hasRunningForSession(sessionId)) return {};`（允许 stop，不 block）。
  - 需要给 hook ctx 传 sessionId（`turn-loop.ts:685` emitHook 的 data 里加）。
  - 语义：goal 没达成不等于要逼 AI 干活——**「在等后台」也是一种合法的「正在推进」**。

- **A-ii**：保留 goal 判定，但 turn-loop 在 continueSession 前先 await 后台作业。改动更深（要把 wait-loop 逻辑下沉进 turn-loop），不推荐。

**采纳 A-i。**

#### A.5 提示词加固（双保险，对应你「两者都做」的倾向）
- `generate-video.ts` 工具描述已有「Do NOT sleep or poll」，**再加强**：「After submitting, if you have no other work, END YOUR TURN — the system will wake you when the video is ready. Never run `sleep`.」
- coding.md / 系统提示里加一条通则：「等后台任务（视频/agent/shell）时，结束本轮，勿 sleep 自旋。」

### 测试（TDD，先红后绿）
- `engine` 集成测试：注入 fake video provider（poll 3 次才 succeeded）+ 设 goal → 断言：
  1. 引擎 park 等待，**不触发额外 goal 续跑轮**（stopBlockCount 不暴涨）。
  2. 视频完成后注入通知，跑且仅跑一轮 summarize。
  3. 全程**没有** `sleep`/手动 poll 工具调用。
- `goal-stop-hook` 单测：`backgroundJobRegistry` 有该 session 作业时，hook 返回 `{}`（允许 stop）；无作业时维持原逻辑。
- `background-jobs.ts` 单测：start/finish/hasRunningForSession/subscribe。

### 风险
- goal loop 是核心，A-i 改 hook 的提前返回要确保**只在真有后台作业时**短路，否则会让 goal 模式提前放行。用 sessionId 精确匹配 + 测试覆盖。
- `backgroundJobRegistry` 是进程内单例，与 asyncAgentRegistry 同模式；在 worker 进程（背景 shell manager 在 worker）需确认视频 poll 跑在哪个进程——视频 poll 在主 engine 进程，OK。

---

## 三、补「视频生成 skill」（问题 2）

### 3.1 现状缺口
seedance 7 个 skill 链到「02-seedance-prompts.md 提示词文本」就结束，**没有「实际生成视频」环节**。AI 只能即兴裸调 API → 卡住。

### 3.2 新增 skill：`seedance-video-generation-skill`
位置：`seedance-project/.claude/skills/seedance-video-generation-skill/`

职责：读 `02-seedance-prompts.md` → 逐条用 **GenerateVideo 后台工具** 生成 → 等通知 → 落 `outputs/<ep>/videos/`。

#### 关键规则（写进 SKILL.md）
1. **必须用 GenerateVideo 工具**，禁止裸调 API、禁止 `sleep`、禁止手动 GET 轮询。
2. **提交后结束本轮**，靠系统通知唤醒（呼应方案 A）。
3. **单图 vs 多图分支**（对应你「单图模型/多图模型逻辑不一样」）：
   - **单图素材引用（1 张参考图）** → image-to-video：`GenerateVideo({ prompt, images:[ref1] })`（1 张 → i2v）。
   - **多图素材引用（2~9 张）** → reference-to-video：`GenerateVideo({ prompt, images:[ref1..refN] })`，prompt 里用 `@Image1..@ImageN` 引用（工具已支持，见 `generate-video.ts:99-102`）。
   - **纯文字（无参考图）** → text-to-video：`GenerateVideo({ prompt })`。
   - **续接镜头（前一镜的成片 URL）** → `GenerateVideo({ prompt, videos:[prevUrl] })`（Seedance 模型，见 `generate-video.ts:103-107`）。
4. **编排策略**（对应你「不同模型按顺序」+「看情况」）：
   - 默认 **并发提交所有独立镜头**（后台并发，靠通知收集，最快）。
   - **有续接依赖的镜头**（镜 N 用镜 N-1 的成片 URL）→ 该链**串行**：等前一镜通知到 → 拿 URL → 再提交下一镜。
   - skill 里给 AI 一段决策逻辑：先扫所有镜头，标出依赖关系，独立的并发提交、依赖链串行。
5. **多模型 fallback**（可选，写成规则）：某镜头默认模型失败/不满意 → 换 `provider`/`model` 重提交；优先级列表在 skill 里列明。

#### 模板
`templates/video-generation-plan.md`：镜头清单 + 每镜的（模型/参考图数/依赖/状态）表格，AI 据此编排。

### 3.3 接进 CLAUDE.md 工作流
在「分镜编写阶段」之后加 **「视频生成阶段」**（指令 `~video [集数]`），调用新 skill。

---

## 四、优化现有 7 个 skill（问题 3）

待动手前逐个 review，初步方向（动手时再细化）：
1. **描述（description）精简**：触发更准。
2. **去重**：4 个 review skill（script-analysis / art-direction / seedance-prompt / compliance）结构高度相似，抽公共「审核流程」骨架，各自只留差异维度。
3. **流程清晰度**：统一「读上游 → 执行 → 输出格式」三段式。
4. **与新视频 skill 衔接**：分镜 skill 产出要明确「素材对应表」格式，供视频 skill 直接消费（@图片编号 → 实际文件路径映射）。

> 具体改动在动手阶段逐 skill 列 diff，不在本稿展开。

---

## 五、不做（你已拍板）
- **打包成 plugin / 上 marketplace**：暂缓（先本地优化）。
  - 备注：子代理随插件**已能自动识别**（`engine.ts:379` `pluginAgentDirs()` + `loadPluginAgents.ts`），CC 格式原样拷、Codex TOML 自动转。打包时记得去掉 agent frontmatter 里硬编码的 `model: deepseek-v4-pro`（否则别人没配 deepseek 会解析失败）。

---

## 六、落地顺序
1. **问题 1（引擎等通知）** — `background-jobs.ts` + GenerateVideo 登记 + engine wait-loop + goal-stop-hook 短路 + 提示词加固 + 测试。改 core 必 rebuild。
2. **视频生成 skill** — 新 skill + CLAUDE.md 接 `~video` 阶段。
3. **优化现有 7 skill** — 逐个精简/去重。
