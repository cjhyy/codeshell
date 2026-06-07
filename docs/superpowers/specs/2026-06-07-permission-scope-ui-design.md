# 权限范围 UI(Approval Scope)设计

> 2026-06-07 · desktop · 三大功能第一项

## 背景与问题

核心权限引擎(`packages/core/src/tool-system/permission.ts`)**已完整支持**三档授权范围,经由 `ApprovalResult.scope`:

```ts
type ApprovalScope = "once" | "session" | "project";
```

`InteractiveApprovalBackend.requestApproval` 已会按 scope 处理:

- `once` —— 仅本次调用(默认,`always` 未置时)。
- `session` —— 记进内存 session 规则;**operation-scoped**(Bash 经 `buildProjectRule` 收窄到 head 命令,如 `git status` → 允许所有 `git …`,而非整个 Bash 工具)。
- `project` —— 持久化到 `<cwd>/.code-shell/settings.local.json`(原子写 tmp+rename),重启后对该项目仍生效;不入 git。

**缺口**:桌面端 `ApprovalCard`(`packages/desktop/src/renderer/approvals/ApprovalCard.tsx`)只给「批准 / 拒绝」两个按钮,固定发 `{ approved: true }`(= once)。用户无法选择 session/project,每次同一操作都被重复打断。机制已全有,**纯 UI + 三层透传缺口**。

附带 bug:用户反馈"点了批准后卡半天才有反应"。期望:点击后**立即**给 UI 反馈(卡片进终态),再后台发 IPC、再执行内容。

## 范围(YAGNI)

**做**:once / session / project 三档选择(机制已具备),+ 乐观反馈修卡顿。

**不做**(刻意排后,需先改 core 规则模型):路径级细粒度白名单("只允许写 `src/`")。`buildProjectRule` 当前 Bash 收窄到 head 命令、其他工具是 tool 粒度;路径级要扩 `argsPattern` 模型,属独立较大活。

## 方案 A:批准 split-button(已选定)

主按钮「批准」= once(一键完成,覆盖 ~80% 场景);旁边 `▾` 展开 DropdownMenu 提供更大范围。拒绝侧保持现状(已有理由 Select)。

```
┌─────────────────────────────────────┐
│  Bash   [medium]   Run shell command │
│  git status                          │
│  show raw args                       │
│                                      │
│  [ 批准  ▾ ]   [拒绝理由…▾]  [拒绝]   │
└──────┬──────────────────────────────┘
       └─ ▾ 展开(shadcn DropdownMenu):
          仅本次
          本会话一直允许
          本项目一直允许  ·写入 .code-shell/settings.local.json
```

被否决的备选:B 三按钮平铺(吵、把高承诺 project 与 once 等权重易误点);C 范围 Select+单批准键(两步、与拒绝侧 Select 叠加更乱)。

## 架构 / 数据流(core 零改动)

```
ApprovalCard
  onDecide(decision: "approve"|"deny", reason?: string, scope?: ApprovalScope)
      │
App.decideEnvelope(env, decision, reason?, scope?)
      │  乐观:先 setApproval(null)+入 history+禁用,再发 IPC
window.codeshell.approve(sessionId, requestId, decision, reason?, answer?, scope?)
      │  拼 decision = approve
      │    ? { approved: true, ...(scope&&scope!=="once" ? {always:true, scope} : {}) }
      │    : { approved: false, reason }
RPC agent/approve → worker → RunApprovalBackend.resolveApproval(result)
      │
core InteractiveApprovalBackend  ←── 已就绪,消费 always+scope,零改动
```

`scope==="once"` 时不带 `always`/`scope`(等价旧行为,保证回归安全)。

### 纯函数(可单测,DOM-free)

```ts
// approvals/approvalDecision.ts
type ApproveChoice = "once" | "session" | "project";
function decisionFromChoice(choice: ApproveChoice):
  { approved: true; always?: boolean; scope?: "once"|"session"|"project" }
// once    → { approved: true }
// session → { approved: true, always: true, scope: "session" }
// project → { approved: true, always: true, scope: "project" }
```

UI 把 split-button 的选择映射成 `ApproveChoice` 交给 `onDecide`;preload `approve` 收一个可选 `scope` 末参,拼进 decision。

## 乐观反馈(修卡顿)

**先诊断后改**(systematic-debugging):`decideEnvelope` 已是 `void approve(...)`(不 await IPC)+ 同步 `setApproval`/`setApprovalQueue`/`setApprovalHistory`,所以 IPC 不阻塞、React 状态本应即时更新。怀疑真因是点击触发 App 多次 setState → 整个 MessageStream 全量重渲染产生感知卡顿,而非 IPC。**实现期先量(埋点/肉眼)再改,不盲修。**

UI 层面无论真因如何都要做的:点击决定后,卡片**立即**切到禁用的终态(`✓ 已批准(本会话)` / `✕ 已拒绝`),按钮 disabled,避免重复点击与"没反应"错觉;实际从流里移除仍由 `pendingApproval` 清空驱动(已同步)。

## 测试 / 验收

- **单测** `approvalDecision.test.ts`:`decisionFromChoice` 三档 → 正确 `approved/always/scope`;once 不带 always/scope。
- **单测** `ApprovalCard.test.tsx`:split-button 展开三项;点"本会话"回调 `onDecide("approve", undefined, "session")`;点主按钮 → `"once"`;拒绝路径不带 scope。
- **回归**:现有 approval 测试全绿;`tsc --noEmit` + `build:renderer` 通过。
- **手动 smoke(需人盯)**:① 批准"本会话"后,同会话再触发同操作不再弹卡片;② 批准"本项目"后 `.code-shell/settings.local.json` 出现对应 allow 规则;③ 点击到卡片进终态的感知延迟可接受。

## 影响文件

- 新增:`approvals/approvalDecision.ts` + `.test.ts`
- 改:`approvals/ApprovalCard.tsx`(split-button)、`App.tsx`(`decideEnvelope` 加 scope + 乐观)、`preload/index.ts`(`approve` 加 scope 末参)、`preload/types.d.ts`(签名)
- core:**不改**(机制已就绪)
