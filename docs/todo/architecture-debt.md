# 架构债务路线图(Architecture Debt)

> 状态:**P0 已落地并入 main**(commit `c191bb51`);P1/P2 待排期。
> 本文是对 `packages/core` 等的架构债务清单 + 修复顺序 + 已知正解。债务的「现状描述」见 `docs/architecture/`(源码级架构文档);本文只记**该改什么、为什么、怎么改**。

原则:每条独立可做、可单独验证、不大爆改。改 core 必走 worktree + rebuild;subagent 不碰 git。

---

## ✅ P0 — 已完成(commit `c191bb51`,2026-06-30)

低风险高收益解耦,均零行为变化,为 P1 拆分打地基。

- **① 断 `tool-system/context.ts → engine` 循环依赖** — 用本地窄接口 `ToolRuntimeHost`(`planMode`/`setPlanMode`/`readWorktreeSetupScripts`)替掉 `import type { Engine }`。这是 engine.ts 难拆的根因之一。
- **② 断 `services/memory-orchestrator → arena` 依赖** — `extractJSON`/`extractJSONArray` 抽到 `utils/json.ts`,arena re-export 保内部不破。core 内部至此**无 import 式 arena 依赖**。
- **③ 抽 `engine/types.ts`** — `EngineConfig`/`EngineHookConfig`/`EngineResult` 移出 3301 行的 engine.ts,纯类型消费者改指 types.ts(P1-⑦ 拆 engine 的前置,避免类型反向 import 抵消收益)。
- **④ 凭证加密边界 `EncryptionCipher` + `PlaintextCipher`** — core 定义接口,`CredentialStore` 在磁盘边界 read 解密 / write 加密,默认 `PlaintextCipher`(= 现状 0o600 明文);旧明文文件仍可读、下次保存自动迁移。`grep safeStorage packages/core/src` 仅注释无代码。

验证:根 typecheck 0;core 测试净增 4 pass(cipher,含双重加密回归守卫)。

---

## 🟡 P1 — 待排期(各自独立 worktree)

### ⑤ 拆 `index.ts`(843 行)成分层入口
`index.ts`(稳定 SDK)/ `index.internal.ts`(in-repo desktop/tui)/ 可选 `index.experimental.ts`。8 处 `@internal` 导出搬到 internal,TUI/desktop 改 import 路径。
**收益**:外部 SDK 面收窄,core 内部重构不再处处算 breaking。
**验证**:`bun run typecheck` 后确认**无新增**与本次相关的错误(项目 typecheck 非 clean gate,有预存错误,别要求"全绿");`bun test` 绿。

### ⑥ arena builtin 改成「可选注册」
把 `tool-system/builtin/arena.ts` 从默认 builtin 抽出 / 注册层可开关。这是 arena 真正解绑 core 的**第一步实操**(比挪目录更要紧)。
**前提认知**:P0-② 只断了 `memory-orchestrator` 一条线;arena 仍牢牢绑在 core 的 **builtin(`tool-system/builtin/arena.ts`)/ protocol(`server.ts` 的 `arena_status` RPC)/ settings(`schema.ts` 的 `arena.participants`)/ onboarding(`saveArenaSettingsByKeys`)/ public index** 里。

### ⑦ 拆 `engine.ts`(3301 行上帝对象)
**前置**:P0-① + ③ 已就绪。按现成边界切:image-policy / sandbox-config / subagent-spawner / runtime-config,engine.ts 只留装配 + run 编排。
**纪律**:动核心必走 worktree + 充分回归;**一次抽一块、每块单测**,别一把梭。

### ⑧ 两个 `App.tsx` 抽 reducer/hook
desktop(3188 行)/ tui(2278 行)的巨型 App。stream 事件路由 + bucket 管理抽 `useStreamRouter`,状态机对齐已共享的 `streamReducer`。
**风险**:UI 竞态敏感(renderer 状态机 bug 高发区);冒烟两端 + 跑现有 renderer 测试。改完必跑当前构建验证(别信旧 bundle)。

### ④-后续 真启用凭证加密(SafeStorageCipher)
P0 只落地了**边界**;`SafeStorageCipher` 已实现待命(`packages/desktop/src/main/credential-cipher.ts`)但**故意未启用**。
**真因 / 必须先解决**:agent 跑在独立 **worker 进程**(无 safeStorage 钥匙)。若 desktop main 用 safeStorage 写 `enc:safeStorage:…`,worker 端读凭证(`UseCredential` / env 暴露)解不出 → **回归**。
**正解**:把 cipher(或解密能力)跨 stdio 递给 worker,两端用同一把钥匙后再 `setDefaultCredentialCipher(new SafeStorageCipher())`。

---

## 🟢 P2 — 排期 / 仅记录

### ⑨ arena 真正移到 `packages/arena`
**先决产品语义**(否则"移目录"会变成半天包边界、半天产品语义):
- `arena_status` 还留不留 protocol?
- `settings.arena.participants` 由 core schema 继续认识,还是 plugin 自己扩展?
- public API 的 `Arena` 等导出算不算稳定 API?
- TUI/desktop 是否还保留 `/arena` 命令入口?
依赖 P1-⑥ 先把 builtin 解绑。

### ⑩ `state.ts` 全局可变单例治理
进程级单例(sessionId/cwd/cost)是全局可变状态池,多 session 并发 worker 里是隐患。**现在不动**——等多 session 并发真出问题时再收敛成显式注入。

### ⑪ cron parser 补边界测试
`automation/cron-expr.ts` 手写 5 字段 parser + DST/时区(零依赖,已踩过一次 Mac 睡眠唤醒 misfire)。**不替换**,补 DST / 闰 / 睡眠唤醒边界测试即可。

### ⑫ 文档:诚实表述「所有 run 过 client/server」的例外
`docs/architecture/04` 把"所有 engine.run 过 AgentServer+AgentClient"写成了硬不变量;实际 sub-agent(`asyncAgentRegistry`)是开了口子的例外。措辞改诚实即可,非代码改动。

---

## 落地顺序

```
✅ P0(已合并 main):① 断循环 → ② utils/json → ③ engine/types → ④ Cipher 边界
P1(各自 worktree):⑤ 拆 index → ⑥ arena builtin 可选 → ⑦ 拆 engine(依赖①③) → ⑧ 拆 App → ④-后续 真启用加密
P2(排期/记录):    ⑨ arena 移包(依赖⑥,先定语义) / ⑩ state / ⑪ cron 测试 / ⑫ 文档措辞
```
