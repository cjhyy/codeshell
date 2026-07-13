# 架构债务路线图(Architecture Debt)

> 状态：**P0 已落地并入 main**（commit `c191bb51`）；本文所列 P1/P2（不含另项 Engine 拆分）
> 已于 2026-07-14 完成实现和复审整改，本提交合入 main。
> 本文是对 `packages/core` 等的架构债务清单 + 修复顺序 + 已知正解。债务的「现状描述」见 `docs/architecture/`(源码级架构文档);本文只记**该改什么、为什么、怎么改**。
> 关联:**目标架构路线**(core 通用化 harness + 插件面板)见 `core-harness-and-plugin-panels.md`(2026-07-02 review 产出)——其 Phase B③④ 覆盖本文 P1-⑥(arena 可选注册推广为 CapabilityModule),Phase C① = P1-⑤,排期时合并执行别做两遍。

原则:每条独立可做、可单独验证、不大爆改。改 core 必走 worktree + rebuild;subagent 不碰 git。

> 2026-07-14 最终结果：Arena 已迁至
> `packages/arena` 并通过 `CapabilityModule` 由 TUI/Desktop 显式装配，core 不再持有 Arena 静态
> builtin/RPC/settings/schema/公开导出；Desktop D1-D7 与 TUI 控制面/渲染 helper 已拆；进程级
> `state.ts` 已删除；Goal 已迁为 versioned `goalLifecycle` 单一持久化真相；cron 与协议文档伴随项完成。
> 复审的 1 Critical、3 High、4 Medium 均已整改，全量 6189 pass / 0 fail。

---

## ✅ P0 — 已完成(commit `c191bb51`,2026-06-30)

低风险高收益解耦,均零行为变化,为 P1 拆分打地基。

- **① 断 `tool-system/context.ts → engine` 循环依赖** — 用本地窄接口 `ToolRuntimeHost`(`planMode`/`setPlanMode`/`readWorktreeSetupScripts`)替掉 `import type { Engine }`。这是 engine.ts 难拆的根因之一。
- **② 断 `services/memory-orchestrator → arena` 依赖** — `extractJSON`/`extractJSONArray` 抽到 `utils/json.ts`,arena re-export 保内部不破。core 内部至此**无 import 式 arena 依赖**。
- **③ 抽 `engine/types.ts`** — `EngineConfig`/`EngineHookConfig`/`EngineResult` 移出 3301 行的 engine.ts,纯类型消费者改指 types.ts(P1-⑦ 拆 engine 的前置,避免类型反向 import 抵消收益)。
- **④ 凭证加密边界 `EncryptionCipher` + `PlaintextCipher`** — core 定义接口,`CredentialStore` 在磁盘边界 read 解密 / write 加密,默认 `PlaintextCipher`(= 现状 0o600 明文);旧明文文件仍可读、下次保存自动迁移。`grep safeStorage packages/core/src` 仅注释无代码。

验证:typecheck **无新增**相关错误(项目 typecheck 非 clean gate,有预存错误 — 见 `CODESHELL.md`,别当"根 0" gate);core 测试净增 4 pass(cipher,含双重加密回归守卫)。

---

## ✅ P1 — 已完成

### ⑤ 拆 `index.ts`(843 行)成分层入口
`index.ts`(稳定 SDK)/ `index.internal.ts`(in-repo desktop/tui)/ 可选 `index.experimental.ts`。8 处 `@internal` 导出搬到 internal,TUI/desktop 改 import 路径。
**收益**:外部 SDK 面收窄,core 内部重构不再处处算 breaking。
**纪律(只做机械分层,别做语义迁移)**:Arena 是一大片**裸公开**导出(`Arena`/`MODEL_PRESETS`/三 Strategy/约 20 个 `Arena*` type/`IterativeArena`,`index.ts` 268–325 行,**未打** `@internal`;而 459 行起 `@internal` 机制已在用)。本步先把 Arena 统一标 `@internal`/experimental,**是否 breaking 删除/迁移留到 P2-⑨** — 否则会提前引爆 P2-⑨ 的产品语义(arena_status/settings.arena/`/arena` 命令)。
**验证**:`bun run typecheck` 确认**无新增**相关错误(非 clean gate 见 `CODESHELL.md`);`bun test` 绿;**`bun run lint:engine-bypass`**(架构回退守卫)+ **`bun run build`**。

**进度**：I1（`index.internal.ts` + package subpath + source alias）已于 `75b46844` 落地；本分支新增
稳定的 `./extension` 窄入口，Arena 改从独立包导出，core 根入口及 internal 入口不再暴露 Arena。

### ⑥ arena builtin 改成「可选注册」
原债务是 Arena 同时绑定 core builtin、固定 protocol query、settings/onboarding 与 public index；只从
preset 名单移除并不能解除静态依赖，因此先建立可信 capability seam，再移动实现与所有权。

**进度**：已完成。bare `new ToolRegistry()` 不安装 Arena；`createArenaCapability()` 贡献工具与
`arena_status` query，TUI/Desktop host 显式装配。core 的 builtin catalog、protocol 与 settings schema
不再静态认识 Arena，原 permission/timeout 元数据保持不变。每个 Engine 使用独立 registry fork，
capability 重名 fail-loud，seed Engine 不会把 Arena 泄漏给 cron/headless runtime。

### ⑦ 拆 `engine.ts`(3301 行上帝对象)
**前置**:P0-① + ③ 已就绪。按现成边界切:image-policy / sandbox-config / subagent-spawner / runtime-config,engine.ts 只留装配 + run 编排。
**纪律**:动核心必走 worktree + 充分回归;**一次抽一块、每块单测**,别一把梭；已删除的
`state.ts` 不得以兼容名义恢复。
**验证**:每块 `bun run typecheck` + 对应 `bun test packages/core/src/engine`;整体收口跑 **`bun run lint:engine-bypass`**(防 engine 绕路/架构回退)+ **`bun run build`**。

### ⑧ 两个 `App.tsx` 抽 reducer/hook
desktop(3188 行)/ tui(2278 行)的巨型 App。stream 事件路由 + bucket 管理抽 `useStreamRouter`,状态机对齐已共享的 `streamReducer`。
**风险**:UI 竞态敏感(renderer 状态机 bug 高发区);冒烟两端 + 跑现有 renderer 测试。改完必跑当前构建验证(别信旧 bundle)。

**进度**：已完成 D1-D7：Desktop 外提 bucket override、transcript hydrate、automation import、session
navigation、host subscriptions、run controller、panel buckets、`AppShell` 与 `SessionPanelDock`；`App.tsx`
由本分支峰值约 5005 行降至 2036 行；三个大 hook 的入口参数已按状态域分组。TUI 同步外提
`app-helpers.tsx` 与 `TuiControlSurface.tsx`，将展示 helper 与
onboarding/model/session/provider/AskUser/input 控制面移出根 App。

### ④-后续 真启用凭证加密（SafeStorageCipher）
已在此前主线完成：Desktop main 持有 OS 解密能力并提供 mediated credential access，worker 不获得
SafeStorage 钥匙；`SafeStorageCipher` 已启用。此项不再属于本轮欠账。

---

## ✅ P2 — 已完成

### ⑨ arena 真正移到 `packages/arena`
已完成。产品语义定案：`arena_status` 由 capability query 贡献；Arena 自有 settings schema/读写；
公开 API 归 `@cjhyy/code-shell-arena`；TUI/Desktop 保留入口并显式组合能力。包依赖保持单向
`arena -> core/extension`，core 中已无 `src/arena` 与 Arena 静态 import。Desktop predist 会物化并
验证 Arena 自身的生产依赖闭包，避免打包后因 sibling 依赖解析失败而静默降级。

### ⑩ `state.ts` 全局可变单例治理
已完成。`ModelFacade` 不再写进程级 usage/timing；权威 usage 由 `LLMClientBase` tracker 与 session
state 维护。core 与 TUI 的兼容消费者已清理，`packages/core/src/state.ts` 及其 public/internal export
已删除，session/cwd/cost 不再共享该进程级可变池。

### ⑪ cron parser 补边界测试
`automation/cron-expr.ts` 手写 5 字段 parser + DST/时区(零依赖,已踩过一次 Mac 睡眠唤醒 misfire)。**不替换**,补 DST / 闰 / 睡眠唤醒边界测试即可。

**进度**：本分支已补纽约春季跳时、秋季重复分钟、2028 闰日；既有 scheduler 测试已覆盖睡眠唤醒
misfire，组合测试通过。

### ⑫ 文档:诚实表述「所有 run 过 client/server」的例外
`docs/architecture/04` 把"所有 engine.run 过 AgentServer+AgentClient"写成了硬不变量;实际 sub-agent(`asyncAgentRegistry`)是开了口子的例外。措辞改诚实即可,非代码改动。

**进度**：已明确 interactive product host 是惯例，SDK/tests 可直接 Engine，sub-agent child Engine 不另开
client/server transport。

---

## 落地顺序

```
✅ P0(已合并 main):① 断循环 → ② utils/json → ③ engine/types → ④ Cipher 边界
✅ P1(worktree):  ⑤ public/internal/extension 分层 → ⑥ CapabilityModule 可选 Arena → ⑧ Desktop/TUI App 拆分
✅ P2(worktree):  ⑨ Arena 移包 / ⑩ 删除 state.ts singleton / ⑪ cron 边界 / ⑫ 文档措辞
另项未纳入本轮：⑦ 拆 engine.ts；凭证加密主链已在此前 main-mediated 方案中落地。
```
