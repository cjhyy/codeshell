# 子代理必须用配置里的 agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** codeshell 运行时的 `Agent` 工具不再允许"随便派生临时子代理"——registry 为空(没配置任何 `.code-shell/agents/*.md`)时整个 Agent 工具不可用;registry 非空时必须传 `agent_type` 且必须是配置里存在的,无 `agent_type` 的临时模式报错。

**Architecture:** 两处改动。(1) `resolveAgentTypeOverrides`(agent.ts):registry 非空且未传 agent_type → throw,列出可用 agent(原本返回 `{}` 进临时模式)。(2) `engine.run()` 构造工具定义列表处(engine.ts:1194 附近,已在为 Agent 改描述):registry 为空时,从工具列表里过滤掉 `Agent`/`AgentStatus`/`AgentCancel`,LLM 看不到、不能派生。registry 在 run() 期间懒加载(`getAgentDefinitions`),engine 构造时尚未就绪,所以工具过滤必须放在 run() 里拿到 `toolCtx.agentDefinitions` 之后。

**Tech Stack:** TypeScript, bun test。直接在 main 提交,不开分支。

---

## File Structure

| 文件 | 改动 |
|---|---|
| `packages/core/src/tool-system/builtin/agent.ts` | `resolveAgentTypeOverrides`:registry 非空+无 agent_type → throw |
| `packages/core/src/tool-system/builtin/agent.resolve-type.test.ts` | 新建:覆盖临时模式被拒 |
| `packages/core/src/engine/engine.ts` | run() 工具列表构造处:registry 为空过滤掉 Agent 三件套 |

---

## Task 1: `resolveAgentTypeOverrides` 禁止临时模式(TDD)

**背景:** 现状 `resolveAgentTypeOverrides`(agent.ts:52-68)在 `!agentType` 时 `return {}`(临时模式)。改为:**只要 registry 里有定义(list().length>0),未传 agent_type 就 throw**。registry 为空时仍返回 `{}`(此时整个 Agent 工具会被 Task 2 摘掉,走不到这里;但保留 `{}` 行为以防被其它路径调用,且让单测语义清晰)。

**Files:**
- Create: `packages/core/src/tool-system/builtin/agent.resolve-type.test.ts`
- Modify: `packages/core/src/tool-system/builtin/agent.ts:52-68`

- [ ] **Step 1: 写失败测试**

Create `packages/core/src/tool-system/builtin/agent.resolve-type.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { resolveAgentTypeOverrides } from "./agent.js";
import { AgentDefinitionRegistry } from "../../agent/agent-definition-registry.js";

/** Build a registry holding the given agent definitions (name + minimal fields). */
function registryWith(names: string[]): AgentDefinitionRegistry {
  const reg = new AgentDefinitionRegistry();
  for (const name of names) {
    // @ts-expect-error — test helper pokes a definition in directly
    reg.defs.set(name, { name, description: `${name} role`, systemPrompt: "x" });
  }
  return reg;
}

describe("resolveAgentTypeOverrides — must use a configured agent", () => {
  it("throws when registry has agents but no agent_type given (no ephemeral)", () => {
    const reg = registryWith(["researcher", "planner"]);
    expect(() => resolveAgentTypeOverrides(undefined, reg)).toThrow(
      /agent_type is required/i,
    );
    // error lists available agents
    expect(() => resolveAgentTypeOverrides(undefined, reg)).toThrow(/researcher/);
  });

  it("throws on unknown agent_type and lists available", () => {
    const reg = registryWith(["researcher"]);
    expect(() => resolveAgentTypeOverrides("nope", reg)).toThrow(/unknown agent_type/i);
    expect(() => resolveAgentTypeOverrides("nope", reg)).toThrow(/researcher/);
  });

  it("returns overrides for a valid configured agent_type", () => {
    const reg = registryWith(["researcher"]);
    const ov = resolveAgentTypeOverrides("researcher", reg);
    expect(ov.appendSystemPrompt).toBe("x");
  });

  it("returns {} when registry is empty and no agent_type (tool will be removed anyway)", () => {
    const reg = registryWith([]);
    expect(resolveAgentTypeOverrides(undefined, reg)).toEqual({});
    expect(resolveAgentTypeOverrides(undefined, undefined)).toEqual({});
  });
});
```

> 实现前先确认 `AgentDefinitionRegistry` 的真实构造方式与内部存储字段名。上面 helper 假设有一个 `defs: Map` 字段且无参构造可用;**若不符**(比如只有 `loadFromDirs` 静态工厂、私有字段名不同),改用 registry 暴露的真实 API 构造测试夹具(例如直接 new 后调用某个 add 方法,或用一个实现了 `get()`/`list()` 的最小 stub 对象,只要满足 `resolveAgentTypeOverrides` 用到的 `registry.get(name)` 和 `registry.list()` 即可)。保持 4 个测试的断言语义不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bun test packages/core/src/tool-system/builtin/agent.resolve-type.test.ts`
Expected: FAIL —— 第一个测试不抛错(当前 `!agentType` 返回 `{}`)。

- [ ] **Step 3: 改实现**

把 agent.ts:52-68 的 `resolveAgentTypeOverrides` 改为:

```ts
export function resolveAgentTypeOverrides(
  agentType: string | undefined,
  registry: AgentDefinitionRegistry | undefined,
): AgentTypeOverrides {
  const available = registry?.list().map((d) => d.name) ?? [];
  if (!agentType) {
    // No ephemeral sub-agents: when any agent is configured, an agent_type is
    // mandatory. (Empty registry → {} ; the Agent tool itself is removed in
    // that case, so this path isn't reached in practice.)
    if (available.length > 0) {
      throw new Error(
        `agent_type is required — ephemeral sub-agents are disabled. ` +
          `Pass one of: ${available.join(", ")}`,
      );
    }
    return {};
  }
  const def = registry?.get(agentType);
  if (!def) {
    const list = available.join(", ") || "(none defined)";
    throw new Error(`unknown agent_type '${agentType}'. Available: ${list}`);
  }
  return {
    model: def.model,
    maxTurns: def.maxTurns,
    toolAllowlist: def.tools,
    appendSystemPrompt: def.systemPrompt,
  };
}
```

也更新该函数上方的 JSDoc(:47-51):把"Omitted type → empty overrides (ephemeral mode)"改成"Omitted type with a non-empty registry → throw (ephemeral mode disabled); empty registry → {}"。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bun test packages/core/src/tool-system/builtin/agent.resolve-type.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: typecheck + 全量 core 测试(防回归)**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bunx tsc --noEmit -p packages/core/tsconfig.json && bun test packages/core/`
Expected: 均 PASS。
注意:若有既有测试依赖"无 agent_type 的临时 agent"行为而失败,需评估——按本需求这是预期行为变更,应更新那些测试以传 agent_type 或断言新行为(在该 step 里一并修,并在 commit message 说明)。

- [ ] **Step 6: Commit**

```bash
cd "/Users/admin/Documents/个人学习/代码学习/codeshell"
git add packages/core/src/tool-system/builtin/agent.ts packages/core/src/tool-system/builtin/agent.resolve-type.test.ts
git commit -m "feat(core): require configured agent_type — disable ephemeral sub-agents"
```

---

## Task 2: registry 为空时从工具列表摘掉 Agent 三件套

**背景:** `engine.run()` 在约 1194 行构造发给 LLM 的工具定义列表 `allToolDefs`,其中已对 `Agent` 工具替换描述(注入可用 agent 列表)。在此处加:registry 为空时,过滤掉 `Agent`/`AgentStatus`/`AgentCancel` 三个工具,LLM 完全看不到。registry 来自 `toolCtx.agentDefinitions`(此时已懒加载就绪)。

**Files:**
- Modify: `packages/core/src/engine/engine.ts:1194-1207`(allToolDefs 构造处)

- [ ] **Step 1: 读现状确认锚点**

读 engine.ts 1190-1210,确认这段(现状大致):

```ts
const allToolDefs = this.toolRegistry.getToolDefinitions().map((t) =>
  t.name === "Agent"
    ? { ...t, description: agentToolDefWithTypes(toolCtx.agentDefinitions).description }
    : t,
);
```

(变量名以真实代码为准:`allToolDefs`、`toolCtx.agentDefinitions`、`agentToolDefWithTypes`。)

- [ ] **Step 2: 改为先过滤再映射**

把上面那段改为(注意用 `const` 改 `let`,或拆成两步;以下用一个常量判定 + 过滤):

```ts
// Agent (and its companions) are only available when at least one agent is
// configured under .code-shell/agents. With an empty registry we strip them
// entirely so the model cannot spawn ephemeral sub-agents — see the
// "must use a configured agent" requirement.
const agentRegistryEmpty =
  (toolCtx.agentDefinitions?.list().length ?? 0) === 0;
const NESTED_AGENT_TOOL_NAMES = ["Agent", "AgentStatus", "AgentCancel"];
const allToolDefs = this.toolRegistry
  .getToolDefinitions()
  .filter((t) => !(agentRegistryEmpty && NESTED_AGENT_TOOL_NAMES.includes(t.name)))
  .map((t) =>
    t.name === "Agent"
      ? { ...t, description: agentToolDefWithTypes(toolCtx.agentDefinitions).description }
      : t,
  );
```

> 若 engine.ts 顶部已有 `NESTED_AGENT_TOOLS` 常量(约 255 行,值 `["Agent","AgentStatus","AgentCancel"]`),**复用它**而不要新定义 `NESTED_AGENT_TOOL_NAMES`——把 filter 里的数组换成那个已有常量,删掉本地定义。实现时确认该常量在此作用域可见。

- [ ] **Step 3: typecheck**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bunx tsc --noEmit -p packages/core/tsconfig.json`
Expected: PASS

- [ ] **Step 4: 全量 core 测试(防回归)**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bun test packages/core/`
Expected: PASS。若有测试假设"空 registry 下 Agent 工具仍在列表里"而失败,按新行为更新。

- [ ] **Step 5: Commit**

```bash
cd "/Users/admin/Documents/个人学习/代码学习/codeshell"
git add packages/core/src/engine/engine.ts
git commit -m "feat(core): hide Agent tool when no agents are configured"
```

---

## Task 3: rebuild core + 提交计划

- [ ] **Step 1: rebuild core**(desktop/tui dist 引用 core)

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bun run --filter '@cjhyy/code-shell-core' build`
Expected: 成功。

- [ ] **Step 2: 提交计划文档**

```bash
cd "/Users/admin/Documents/个人学习/代码学习/codeshell"
git add docs/superpowers/plans/2026-06-01-subagent-require-configured.md
git commit -m "docs: 计划 — 子代理必须用配置里的 agent"
```

---

## 手动验证(实现后)

1. 一个**没有** `.code-shell/agents/*.md` 的项目里启动 codeshell:模型的工具集中不应出现 `Agent`/`AgentStatus`/`AgentCancel`,无法派生子代理。
2. 一个**有**配置 agent 的项目里:Agent 工具可用,描述里列出可用 agent;若模型调用 Agent 不传 `agent_type`,返回错误"agent_type is required …",列出可用 agent;传配置里存在的 agent_type 正常运行。

## Notes
- 子代理嵌套防护(子代理工具集剔除 Agent 三件套,engine.ts resolveChildToolScope)保持不变,与本改动正交。
- 直接在 main 提交,不开分支。
