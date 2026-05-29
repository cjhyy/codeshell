# 设计:拆分「完全访问权限」与「Goal 模式」

**日期**: 2026-05-29
**关联**: `TODO-week.md` #3;修正 commit `58e6114`
**作者**: junhong.chen + Claude

## 背景与问题

Commit `58e6114`(`feat(desktop): replace 完全访问权限 with Goal 模式`)把两个**互相正交**的概念混成了一个:

- **完全访问权限**(full access)—— 一个**权限级别**。表示「对所有审批请求一律放行」。
- **Goal 模式** —— 一个关于**自主性/持续性**的概念。用户设定一个目标,agent **跑到目标达成为止**(loop-until-done)。它跟权限没有直接关系;唯一的联系是:开启 Goal 时**默认**把权限设成完全访问,免得跑一半被审批打断 —— 但用户仍可手动调回。

commit 的错误有两处:
1. **删掉了** `bypass`(完全访问权限),它本身没问题,应保留。
2. 把它**改名**成 "Goal 模式" 并映射到 engine `auto` backend(危险拦截式)—— 这不是 Goal 模式的语义。

### 现状核对(2026-05-29 阅码确认)

- **`bypassPermissions` backend 仍然在 core 里存在**,没被删。
  `packages/core/src/types.ts:160-166` 的 `PermissionMode` 仍含 `"bypassPermissions"`;
  `engine.ts` 的 `buildPermissionConfig()` 在该 mode 下选 `HeadlessApprovalBackend("approve-all")`(全放行);
  `permission.ts:673` 的 `classify()` 对 `bypassPermissions` 直接返回 `"allow"`。
  → **恢复完全访问权限是纯 desktop 层的事,engine 后端已就绪。**
- **codeshell 没有任何 loop-until-goal 机制。** `TurnLoop.run()`(`turn-loop.ts:208-591`)在模型不再发工具调用时返回 `reason: "completed"` 即停。没有 `goal` / `untilDone` / `autoContinue`。
- **codeshell 没有 CC 式的 `Stop` hook 事件。** `HookEventName`(`events.ts:76-92`)里没有 `on_stop`;最接近的 `on_turn_end` 是 notify-only,`on_session_end` 在循环结束后、无法再注入。要镜像 CC 必须**新增**这个 seam。

### 参照:Claude Code 怎么做(已向 claude-code-guide 求证)

CC **没有**内置「loop until goal」功能。它的自主性只有两个来源:
1. 模型在一个 turn 内自然链式调工具;
2. **Stop hook**:agent 想停时,hook 返回 `{"ok": false, "reason": "..."}` 阻止停止,`reason` 作为下一条指令喂回给模型。「目标达成了吗」的判定由 **prompt hook / agent hook**(LLM 驱动)在 hook *内部*完成 —— core 循环本身是「无脑」的。有**连续阻止上限**(CC 默认 8 次)防死循环。

→ **本设计镜像 CC 的 stop-hook 路线**:core 循环只提供「停之前问一下 hook,hook 说继续就注入消息接着跑」的 seam;「是否达成」的 LLM 判定放进一个内置 Goal hook 里。

## 目标

1. **恢复**完全访问权限为一个独立权限级别,映射 engine `bypassPermissions`。
2. **新增** Goal 模式为一个**正交**于权限的能力:设目标 → 跑到完成为止,带上限。
3. Goal 的「是否达成」判定**镜像 CC**:用一个新增的 `on_stop` hook seam + 一个内置 Goal hook(用**当前会话模型**做一次有界判定调用)。
4. desktop 上 Goal 通过**复用现有输入框 + 一个 Goal 开关**入口;开启时权限 pill **默认**跳到完全访问(可手动改)。

## 非目标(YAGNI)

- 不做可配置的「判定专用便宜模型」—— 用当前会话模型。
- 不做独立的 Goal 目标输入框 —— 复用 composer 现有输入。
- 不暴露 `on_stop` 给用户自定义 hook 配置(本轮只供内置 Goal hook 用);用户自定义 stop hook 可作后续。
- 不动 `auto` backend(它仍存在,只是不再被错误地叫成 "Goal")。

---

## 架构

两块**独立**的改动,可分别 commit、分别测试。

### Part 1 — 恢复完全访问权限(desktop-only,零 engine 改动)

把 commit `58e6114` 在 desktop 层做的「删 bypass / 改名 goal」回滚成正确形态:

**`PermissionPill.tsx`**
- `PermissionMode` union:把 `"goal"` 从权限 mode 里**移除**(Goal 不再是权限级别),恢复 `"bypass"`。
  → `"plan" | "default" | "accept_edits" | "bypass"`
- `CorePermissionMode`:恢复 `"bypassPermissions"`,移除 `"auto"`(auto 不再从 pill 暴露)。
  → `"plan" | "default" | "acceptEdits" | "bypassPermissions"`
- `MODES` 列表:删 goal 项,恢复 bypass 项 —— label「完全访问权限」,tone `"err"`,hint「所有操作一律放行,不再询问」。
- `toCorePermissionMode`:`"bypass" → "bypassPermissions"`。
- `fromSettingsPermissionMode`:`"bypass" | "bypassPermissions" → "bypass"`;**删掉**把 bypass 降级到 goal 的 legacy 分支;`"auto"` 落到 `"default"`(auto 不再有 pill 表示,作保守降级)。

**已落地配置的迁移**:commit `58e6114` 上线的几天里,可能有 session override / 设置页默认被写成了 `"goal"`。`fromSettingsPermissionMode` 把残留的 `"goal"` 落到 `"default"`(而非 bypass)—— Goal 已不是权限值,保守降级到默认询问,不擅自给用户开全放行。session override(`permissionOverrides`,localStorage)里的 `"goal"` 同理由这条读取路径归一化。

**`App.tsx`** `onApprovalRequest`
- 恢复:当当前 bucket 的权限 mode 是 `bypass` 时,renderer 侧对到达的审批请求**直接 approve**(commit 前的行为)。注:engine 的 `bypassPermissions` 后端本就全放行、通常不会有请求到达 renderer;这层是 belt-and-braces,语义上「完全访问 = 不打断用户」。

**`PermissionSection.tsx`(设置页)**:同样的 swap,全局/项目默认选项恢复完全访问、去掉 goal。

**`preload` run opts**:`permissionMode` 类型恢复含 `bypassPermissions`(已是 `string`,无需改类型,只是语义)。

### Part 2 — Goal 模式(engine + desktop)

#### 2a. 新增 `on_stop` hook seam(`packages/core`)

- `events.ts`:`HookEventName` 加 `"on_stop"`。`HookResult` 已有 `stop?: boolean`、`messages?: string[]` —— **复用**它们:
  - hook 返回 `stop: true` + `messages: [...]` → 「**别停,把这些消息注入后接着跑**」。
  - hook 返回空 / `stop` 不为 true → 「允许停」。
  - (语义注:这里 `stop:true` = 「阻止 agent 停下」,与 registry 里 `stop` 表「停止 hook 链」不同上下文;在 `on_stop` 事件下我们按「阻止终止」解释。文档注释写清。)
- `TurnLoop.run()`:在**本会返回 `reason: "completed"` 的那个点**(`turn-loop.ts:395-407`,模型无工具调用处),返回前先 `emitHook("on_stop", { goal, finalText, turnCount })`:
  - 若结果 `stop === true` 且有 `messages`:把这些消息作为合成 user 消息 `push` 进 `messages`,**不返回**,`continue` 外层 while 接着跑下一个 turn。
  - 否则照常 `return { reason: "completed" }`。
- **连续阻止上限**:`TurnLoop` 内计 `stopBlockCount`;每次 `on_stop` 阻止 +1,正常完成清零。达到 `maxStopBlocks`(默认 8,镜像 CC)时**强制放行**停止,并发一条 `text_delta`/日志说明「已达 Goal 续跑上限」。同时整体仍受 `maxTurns` 硬顶约束。

#### 2b. 内置 Goal hook(`packages/core`)

- 新文件 `packages/core/src/hooks/goal-stop-hook.ts`:导出一个工厂 `createGoalStopHook({ goal, llm, log })`,返回一个注册到 `on_stop` 的 handler。
- handler 逻辑(镜像 CC 的 prompt hook):
  1. 无 `goal` → 返回空(允许停)。
  2. 有 `goal` → 用**当前会话模型**(`llm`,即 engine 已持有的 modelFacade/LLM client)发**一次**判定调用:system「你是目标完成度裁判」,user 含 `goal` + 最近 assistant 输出摘要 + 「目标完全达成了吗?若否,列出还差什么。仅返回 JSON `{met: bool, gaps: string}`」。
  3. `met: true` → 返回空(允许停)。
  4. `met: false` → 返回 `{ stop: true, messages: ["继续 —— 目标尚未达成,还差:" + gaps] }`。
  5. 判定调用本身失败/超时 → **保守允许停**(不卡死会话),记一条 warn 日志。
- 判定调用的 token 计入会话用量(与会话同模型,符合用户选择)。

#### 2c. goal 穿透链(`packages/core` 协议层)

- `RunParams`(`protocol/server.ts`)加 `goal?: string`。
- `EngineConfigSlice` / Engine config 加 `goal?: string`(随 `permissionMode` 一起穿透:server → ChatSessionManager.getOrCreate → engine factory → Engine 构造)。
- `Engine.run()`:若 `this.config.goal`,在构造 `TurnLoop` 前 `this.hooks.register("on_stop", createGoalStopHook({ goal, llm: <session model>, log }))`。把 `goal` 一并传进 `TurnLoop` config(供 `on_stop` data 里带上、供日志)。`maxStopBlocks` 走默认 8。

#### 2d. desktop 入口(复用输入框 + 开关)

- **`ChatView` / composer**:加一个轻量 **Goal 开关**(与权限 pill 并列的小 toggle/chip,label「Goal」,hint「设目标后跑到完成为止」)。状态 `goalEnabled: boolean`,与权限 mode 一样按 bucket override + 默认。
- **开关联动权限默认**:`goalEnabled` 从关→开时,若当前 bucket 没有显式权限 override,把权限 pill **默认**跳到完全访问(`bypass`);用户随后仍可手动改回任意级别(联动只发生在开启那一刻,不强制锁定)。
- **`App.send`**:当 `goalEnabled` 时,把**当前输入框文本**作为 `goal` 一并放进 `run()` opts(`opts.goal = text`)。注意:goal 文本 == 本轮 prompt 文本(复用输入框,符合用户选择)。
- **`preload` run opts**:加 `goal?: string`(已是 `& Record<string, unknown>`,类型上加显式字段更清晰)。

---

## 数据流

```
[Part 1 完全访问]
  PermissionPill (bypass) → toCorePermissionMode → "bypassPermissions"
    → run() opts.permissionMode → preload → main → server RunParams
    → Engine config.permissionMode → buildPermissionConfig
    → HeadlessApprovalBackend("approve-all")   [全放行,已存在]
  App.onApprovalRequest: bucket mode==bypass → 直接 approve  [belt-and-braces]

[Part 2 Goal]
  composer Goal 开关 on + 输入框文本
    → App.send: opts.goal = text (+ 默认 permission 跳 bypass)
    → preload → main → server RunParams.goal
    → Engine config.goal
    → Engine.run: register on_stop = createGoalStopHook({goal, llm, log})
    → TurnLoop 跑;模型无工具调用、本欲 reason:"completed"
        → emitHook("on_stop", {goal, finalText, turnCount})
        → GoalStopHook: 用会话模型判定 met?
            met  → 允许停 → reason:"completed"
            !met → {stop:true, messages:["继续,还差:"+gaps]}
                 → 注入合成 user 消息 → continue while → 下一 turn
        → stopBlockCount 达 maxStopBlocks(8) 或 turnCount 达 maxTurns → 强制停
```

## 错误处理

- **判定 LLM 调用失败/超时** → 保守允许停 + warn 日志。绝不因裁判挂掉而卡死会话。
- **goal 为空字符串** → 视同无 goal,GoalStopHook 直接放行(防开关开了但输入框空)。
- **连续阻止达上限** → 强制停,发一条用户可见说明(「Goal 续跑已达 8 次上限,先停下」),不静默截断。
- **bypass 全放行**仍受 engine 既有的不可逆操作保护?—— 不,bypass 的语义就是「完全」;tone 设 `err`(红)在 UI 上明确警示。这是用户主动选择的级别。

## 测试

- **PermissionPill**(扩展现有 `tests/permission-pill-modes.test.ts`):
  - `toCorePermissionMode("bypass") === "bypassPermissions"`。
  - `fromSettingsPermissionMode` 对 `"bypass" | "bypassPermissions"` 都 → `"bypass"`;对 `"auto"` → `"default"`;不再有 bypass→goal。
- **on_stop seam**(新 turn-loop 测试):
  - 无 on_stop hook → `completed` 照常返回。
  - hook 返回 `{stop:true, messages}` → 注入并多跑一个 turn,messages 进了下一次 LLM 输入。
  - 连续阻止达 `maxStopBlocks` → 强制 `completed`。
- **GoalStopHook**(新单测,mock LLM):
  - 无 goal → 允许停。
  - `met:true` → 允许停。
  - `met:false` → `{stop:true, messages 含 gaps}`。
  - LLM 抛错 → 允许停 + 不抛。
- **goal 穿透**(协议层):`RunParams.goal` → engine config.goal → 注册了 on_stop hook(spy registry)。
- 全量 `typecheck` + 现有测试不回归。

## 实施顺序

1. **Part 1**(纯 desktop,低风险,先恢复用户期望的完全访问)→ commit。
2. **Part 2a + 2b + 2c**(engine:on_stop seam + GoalStopHook + 穿透,TDD)→ commit。
3. **Part 2d**(desktop Goal 开关 + 联动)→ commit。
4. 更新 `TODO-week.md` #3 备注,修正 commit `58e6114` 的描述偏差。
