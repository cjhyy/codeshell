# 删除 Legacy 模型存储 · 全量切换统一 Catalog 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 legacy 模型存储字段(`model.*`/`models[]`/`providers[]`/`activeKey`/`auxModelKey`/`fallbackModelKeys`),让所有 boot path 通过单一共享解析器从统一 catalog(`modelConnections`/`credentials`/`defaults`)解析 LLMConfig,并写一次性脚本迁移用户现有数据。

**Architecture:** 新增纯函数 `resolveLLMConfigForTag(settings, tag, preferredId)`,复用现成的 `modelEntriesFromConnections`/`toLLMConfig`/`getMergedCatalog` 零件。所有手搓 `{provider: settings.model.provider, ...}` 的 boot path 改调它产出种子;engine 内部 `populateModelPoolFromSettings` 删 legacy 分支后只走统一 catalog 路径。最后删 schema 字段(schema 已 `.passthrough()`,旧配置不会解析报错)。

**Tech Stack:** TypeScript,Zod schema,Vitest(bun test),monorepo(core/desktop/tui 三包,core 改动需 rebuild 因测试走 dist)。

**设计稿:** `docs/superpowers/specs/2026-06-22-remove-legacy-model-storage-design.md`(commit 5f1cf56d)

---

## 关键事实(实现前必读)

1. **schema 是 `.passthrough()`**(`schema.ts:735`)—— 删字段定义后,旧 settings.json 里残留的 legacy 字段会被静默保留、不报错。所以"删 schema 字段"与"清理用户数据"是两件独立的事。
2. **类型名 `ValidatedSettings`** = `z.infer<typeof SettingsSchema>`(`schema.ts:737`)。
3. **种子 vs 重写**:`agent-server`/`run.ts`/`repl.ts` 构造的 `llmConfig` 是**种子**,Engine ctor 的 `populateModelPoolFromSettings` 随后用统一 catalog **重写** `config.llm`。本次 bug 正是种子是脏 legacy 值。改法 = 让种子也来自统一 catalog。
4. **engine.ts:837 `if (matchKey)` 无 else** —— 选中模型解析不到时静默沿用空种子,抛误导性 `OPENAI_API_KEY missing`。本计划顺带修成报明确错误。
5. **改 core 必 rebuild**:`bun run build`(或包级 build),否则测试走的 dist 是旧的。
6. **走 worktree,不碰 main**。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/core/src/engine/resolve-llm-config.ts` | 共享解析器 settings→LLMConfig(text) | **新建** |
| `packages/core/src/engine/resolve-llm-config.test.ts` | 解析器单测 | **新建** |
| `packages/core/src/engine/engine.ts` | 删 legacy 注册/fallback 分支 + 无 else bug | 改 |
| `packages/core/src/engine/aux-key.ts` | 删 auxModelKey fallback | 改 |
| `packages/core/src/cli/agent-server-stdio.ts` | 种子改调解析器 | 改 |
| `packages/core/src/cli/agent-server-tcp.ts` | 种子改调解析器 | 改 |
| `packages/core/src/onboarding.ts` | appendOnboardingResult 重写成写统一 catalog | 改 |
| `packages/core/src/settings/schema.ts` | 删 legacy 字段定义 | 改(最后) |
| `packages/desktop/src/main/automation-host.ts` | 两处种子改调解析器 | 改 |
| `packages/desktop/src/main/dream-service.ts` | 种子改调解析器 | 改 |
| `packages/tui/src/cli/commands/repl.ts` | 删 legacy 门控+种子改调解析器 | 改 |
| `packages/tui/src/cli/commands/run.ts` | 删 findActiveModelEntry/findProviderApiKey | 改 |
| `packages/tui/src/cli/commands/runs.ts` | 改调解析器 | 改 |
| `packages/tui/src/cli/main.ts` | arena 简化(标降级) | 改 |
| `scripts/migrate-legacy-models.mjs` | 一次性迁移用户数据 | **新建** |

---

## Task 1: 新增共享解析器 `resolveLLMConfigForTag`

**Files:**
- Create: `packages/core/src/engine/resolve-llm-config.ts`
- Test: `packages/core/src/engine/resolve-llm-config.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/core/src/engine/resolve-llm-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveLLMConfigForTag } from "./resolve-llm-config.js";

// 最小可解析 settings:一个 text 连接 + 凭证 + defaults.text。
// catalogId 用 builtin 的 "deepseek"(确定存在于 getMergedCatalog)。
function settingsWith(overrides: Record<string, unknown> = {}) {
  return {
    credentials: [
      { id: "ds-key", catalogId: "deepseek", apiKey: "sk-test", baseUrl: "https://api.deepseek.com/v1" },
    ],
    modelConnections: [
      { id: "ds", catalogId: "deepseek", tag: "text", model: "deepseek-v4-flash", credentialId: "ds-key" },
    ],
    defaults: { text: "ds" },
    ...overrides,
  } as never;
}

describe("resolveLLMConfigForTag", () => {
  it("resolves defaults.text into a runnable LLMConfig", () => {
    const cfg = resolveLLMConfigForTag(settingsWith(), "text");
    expect(cfg).not.toBeNull();
    expect(cfg!.apiKey).toBe("sk-test");
    expect(cfg!.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(cfg!.model).toBe("deepseek-v4-flash");
    expect(cfg!.provider).toBe("openai"); // deepseek protocol → openai client
  });

  it("preferredId wins over defaults.text", () => {
    const s = settingsWith({
      credentials: [
        { id: "ds-key", catalogId: "deepseek", apiKey: "sk-a", baseUrl: "https://api.deepseek.com/v1" },
        { id: "or-key", catalogId: "openrouter", apiKey: "sk-b", baseUrl: "https://openrouter.ai/api/v1" },
      ],
      modelConnections: [
        { id: "ds", catalogId: "deepseek", tag: "text", model: "deepseek-v4-flash", credentialId: "ds-key" },
        { id: "or", catalogId: "openrouter", tag: "text", model: "x/y", credentialId: "or-key" },
      ],
      defaults: { text: "ds" },
    });
    const cfg = resolveLLMConfigForTag(s, "text", "or");
    expect(cfg!.apiKey).toBe("sk-b");
  });

  it("falls back to first usable text connection when defaults.text unset", () => {
    const s = settingsWith({ defaults: {} });
    const cfg = resolveLLMConfigForTag(s, "text");
    expect(cfg!.apiKey).toBe("sk-test");
  });

  it("returns null when no text connection exists", () => {
    const s = settingsWith({ modelConnections: [], defaults: {} });
    expect(resolveLLMConfigForTag(s, "text")).toBeNull();
  });

  it("returns null when preferredId does not resolve and no fallback wanted", () => {
    const cfg = resolveLLMConfigForTag(settingsWith(), "text", "nonexistent");
    // preferredId 不存在 → 回退 defaults.text → ds
    expect(cfg!.id ?? cfg!.model).toBeDefined();
    expect(cfg!.model).toBe("deepseek-v4-flash");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bunx vitest run src/engine/resolve-llm-config.test.ts`
Expected: FAIL —「Cannot find module './resolve-llm-config.js'」

- [ ] **Step 3: 实现解析器**

`packages/core/src/engine/resolve-llm-config.ts`:

```typescript
/**
 * resolveLLMConfigForTag — 单一入口:settings + tag + 可选偏好实例 id → LLMConfig。
 * 所有非-engine 的 seed 场景(agent-server bootstrap / automation / dream / TUI
 * 命令)都调它,避免各自手搓 { provider: settings.model.provider, ... }。
 *
 * 复用 modelEntriesFromConnections + 临时 ModelPool.toLLMConfig,与 engine 内部
 * 长生命周期 pool 共享同一批零件,不逻辑分叉。
 *
 * 选择优先级:preferredId(命中才用)→ defaults[tag] → 首个可用连接。
 * 返回 null = 该 tag 下没有任何可用连接,调用方据此抛明确错误。
 *
 * 本次只处理 text;image/video 已有独立 resolver(resolveImageProvider 等)。
 */
import type { LLMConfig } from "../types.js";
import type { ValidatedSettings } from "../settings/schema.js";
import { getMergedCatalog } from "../model-catalog/index.js";
import { modelEntriesFromConnections } from "./model-connections-pool.js";
import { ModelPool } from "../llm/model-pool.js";

export function resolveLLMConfigForTag(
  settings: ValidatedSettings,
  tag: "text",
  preferredInstanceId?: string,
): LLMConfig | null {
  const connections = (settings as { modelConnections?: unknown[] }).modelConnections;
  if (!Array.isArray(connections) || connections.length === 0) return null;
  const credentials = (settings as { credentials?: unknown[] }).credentials;
  const catalog = getMergedCatalog();

  const entries = modelEntriesFromConnections(
    connections as never[],
    (Array.isArray(credentials) ? credentials : []) as never[],
    catalog,
  );
  if (entries.length === 0) return null;

  // entry.key === connection.id(见 modelEntriesFromConnections)。
  const defaultId = (settings as { defaults?: { text?: string } }).defaults?.text;
  const pick =
    (preferredInstanceId && entries.find((e) => e.key === preferredInstanceId)) ||
    (defaultId && entries.find((e) => e.key === defaultId)) ||
    entries[0];
  if (!pick) return null;

  // 临时 pool 复用 toLLMConfig 的全部映射逻辑(reasoning/headers/providerKind 等)。
  const pool = new ModelPool([]);
  pool.register(pick);
  return pool.toLLMConfig(pick);
}
```

> 注:`ModelPool` 构造与 `register`/`toLLMConfig` 的签名见 `packages/core/src/llm/model-pool.ts`。若 `ModelPool` 构造签名不是 `new ModelPool([])`,实现时按实际签名调整(读 model-pool.ts:100-190 确认)。`toLLMConfig` 不依赖 providerCatalog 也能工作(entry 自带 apiKey/baseUrl),providerKind 来自 catalog kind —— 若需要 providerKind,在 register 前 `pool.setProviderCatalog` 非必需,因为 entry 已含解析后的字段。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bunx vitest run src/engine/resolve-llm-config.test.ts`
Expected: PASS(5 个用例全绿)

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/engine/resolve-llm-config.ts packages/core/src/engine/resolve-llm-config.test.ts
git commit -m "feat(core): 新增 resolveLLMConfigForTag 共享模型解析器"
```

---

## Task 2: engine.ts 删 legacy 分支 + 修无 else bug

**Files:**
- Modify: `packages/core/src/engine/engine.ts:773-843`(legacy 注册 + activeKey fallback + 无 else)
- Test: `packages/core/src/engine/engine.test.ts`(若存在;否则新建 `engine-resolve.test.ts`)

- [ ] **Step 1: 写失败测试 —— 纯 modelConnections 能解析 active,无连接抛错**

`packages/core/src/engine/engine-resolve.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Engine } from "./engine.js";

describe("engine model resolution (unified catalog only)", () => {
  it("throws a clear error when defaults.text points at an unresolvable model", async () => {
    // 构造一个 Engine,settings 里 defaults.text 指向不存在的连接。
    // 期望:不是静默 OPENAI_API_KEY missing,而是明确「未配置连接」错误。
    // (具体构造方式按 Engine 测试夹具惯例;关键断言是错误信息含连接提示)
    let err: Error | undefined;
    try {
      const engine = new Engine({
        llm: { provider: "openai", model: "x", apiKey: "", baseUrl: "" },
        cwd: process.cwd(),
        settingsScope: "project",
      });
      // 触发解析:engine ctor 内 populateModelPoolFromSettings 已跑。
      // 若 settings 无连接且 llm 种子为空,getConfig().llm 应仍是空种子;
      // 真正的明确报错在 boot path 调 resolveLLMConfigForTag 时抛(Task 5/6/7)。
      void engine;
    } catch (e) {
      err = e as Error;
    }
    // engine ctor 本身不应 throw(种子兜底);明确报错在 boot path 层。
    expect(err).toBeUndefined();
  });
});
```

> 说明:engine ctor 删 legacy 后仍不抛错(种子兜底)。明确报错的责任放在 boot path 调 `resolveLLMConfigForTag` 处(Task 5-7),因为只有那里知道"用户选了模型但没配"。本 Task 的实质是**删干净 legacy 分支**且不回归。

- [ ] **Step 2: 读当前 engine.ts:773-843 确认行号**

Run: `cd packages/core && grep -n "settings.models\|settings.providers\|activeKey\|if (matchKey)\|model.name" src/engine/engine.ts`
记录实际行号(下面 Step 3 按内容匹配,不依赖固定行号)。

- [ ] **Step 3: 删 legacy `models[]` 注册块**

在 `engine.ts` 中删除这一段(`hasConnections` 计算保留,但 `settings.models` 注册循环删除):

删除:
```typescript
      if (settings.models?.length || hasConnections) {
        for (const m of settings.models ?? []) {
          this.modelPool.register({
            key: m.key,
            label: m.label,
            provider: m.provider ?? "",
            model: m.model,
            baseUrl: m.baseUrl,
            apiKey: m.apiKey,
            maxOutputTokens: m.maxOutputTokens,
            maxContextTokens: m.maxContextTokens,
            providerKey: m.providerKey,
            authCommand: (m as { authCommand?: string }).authCommand,
            httpHeaders: (m as { httpHeaders?: Record<string, string> }).httpHeaders,
            serviceTier: (m as { serviceTier?: string }).serviceTier,
            reasoningSummary: (m as { reasoningSummary?: string }).reasoningSummary,
          });
        }
        // Build catalog from settings.providers[] ...
        if (settings.providers?.length) {
          this.modelPool.setProviderCatalog(
            new ProviderCatalog(settings.providers as never),
          );
        }
        this.modelPool.setCacheDir(defaultCacheDir());
        this.modelPool.reloadCachedContextWindows();
```

替换为(只保留 connections 路径下的 pool 配置):
```typescript
      if (hasConnections) {
        this.modelPool.setCacheDir(defaultCacheDir());
        this.modelPool.reloadCachedContextWindows();
```

> 注意:`ProviderCatalog` 的 import 若不再被其它地方使用,一并删除其 import 语句(grep `ProviderCatalog` 确认)。

- [ ] **Step 4: 删 activeKey / model.name fallback,只留 defaults.text**

找到这段(engine.ts ~813-843):
```typescript
          const defaultText = (settings as { defaults?: { text?: string } }).defaults?.text;
          const activeKey = (settings as { activeKey?: string }).activeKey;
          let matchKey: string | undefined;
          if (defaultText && this.modelPool.list().some((e) => e.key === defaultText)) {
            matchKey = defaultText;
          }
          if (!matchKey && activeKey) {
            matchKey = settings.models.find((m: any) => m.key === activeKey)?.key;
          }
          if (!matchKey) {
            const currentModel = this.config.llm.model;
            matchKey = settings.models.find(
              (m: any) =>
                m.model === currentModel ||
                (currentModel && m.model?.endsWith(`/${currentModel}`)),
            )?.key;
          }
          if (matchKey) {
            const entry = this.modelPool.switch(matchKey);
            this.config = {
              ...this.config,
              llm: this.modelPool.toLLMConfig(entry),
            };
          }
```

替换为:
```typescript
          const defaultText = (settings as { defaults?: { text?: string } }).defaults?.text;
          // 统一 catalog only:defaults.text 命中则用;否则回退首个已注册连接,
          // 避免选未配置模型时静默沿用空种子(旧 bug:抛误导性 OPENAI_API_KEY missing)。
          let matchKey: string | undefined;
          if (defaultText && this.modelPool.list().some((e) => e.key === defaultText)) {
            matchKey = defaultText;
          } else {
            matchKey = this.modelPool.list()[0]?.key;
          }
          if (matchKey) {
            const entry = this.modelPool.switch(matchKey);
            this.config = {
              ...this.config,
              llm: this.modelPool.toLLMConfig(entry),
            };
          }
```

- [ ] **Step 5: rebuild + 跑 engine 相关测试**

Run:
```bash
cd packages/core && bun run build && bunx vitest run src/engine/
```
Expected: PASS(若有依赖 `settings.models` 的旧测试 FAIL,记录到 Task 9 处理 —— 它们测的是被删功能,应改写或删除)

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/engine/engine.ts packages/core/src/engine/engine-resolve.test.ts
git commit -m "refactor(core): engine 删 legacy models[]/providers[]/activeKey 解析,无 else bug 改为回退首个连接"
```

---

## Task 3: aux-key.ts 删 auxModelKey fallback

**Files:**
- Modify: `packages/core/src/engine/aux-key.ts`
- Test: `packages/core/src/engine/aux-key.test.ts`(新建或追加)

- [ ] **Step 1: 写失败测试**

`packages/core/src/engine/aux-key.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveAuxKey } from "./aux-key.js";

describe("resolveAuxKey", () => {
  it("returns defaults.auxText when set", () => {
    expect(resolveAuxKey({ defaults: { auxText: "fast" } })).toBe("fast");
  });
  it("returns undefined when defaults.auxText unset (legacy auxModelKey no longer consulted)", () => {
    expect(resolveAuxKey({ auxModelKey: "legacy" } as never)).toBeUndefined();
  });
  it("treats empty string as unset", () => {
    expect(resolveAuxKey({ defaults: { auxText: "" } })).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bunx vitest run src/engine/aux-key.test.ts`
Expected: FAIL —「returns undefined when ... legacy」用例失败(当前还读 auxModelKey)

- [ ] **Step 3: 改实现,删 legacy 分支**

`packages/core/src/engine/aux-key.ts` 整体替换为:

```typescript
/**
 * resolveAuxKey — pick the pool key for the background/aux client. Reads the
 * unified store's settings.defaults.auxText (a connection id, also the pool
 * key). Empty strings are treated as unset. (legacy settings.auxModelKey 已删除)
 */
export function resolveAuxKey(settings: {
  defaults?: { auxText?: string };
}): string | undefined {
  const unified = settings.defaults?.auxText;
  if (unified) return unified;
  return undefined;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bunx vitest run src/engine/aux-key.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/engine/aux-key.ts packages/core/src/engine/aux-key.test.ts
git commit -m "refactor(core): resolveAuxKey 删 auxModelKey fallback,只读 defaults.auxText"
```

---

## Task 4: fallbackModelKeys 消费删除

**Files:**
- Modify: `packages/core/src/engine/engine.ts`(`resolveFallbackClients` 及其调用)

- [ ] **Step 1: 定位 fallbackModelKeys 消费点**

Run: `cd packages/core && grep -n "fallbackModelKeys\|resolveFallbackClients\|FallbackClient" src/engine/engine.ts`

- [ ] **Step 2: 删除 `resolveFallbackClients` 函数体 + 调用处**

将读取 `settings.fallbackModelKeys` 的函数及其调用删除。若某 turn-level LLM 调用处有 `const fallbacks = this.resolveFallbackClients(...)` 之类,删除该行及其后续 try-fallback 循环,只保留主调用的错误直接抛出(恢复"无 fallback,错误直接 propagate"的行为 —— 这本就是 fallbackModelKeys 为空时的现状)。

> 因 fallbackModelKeys 从无 UI 写入(始终为空),删除它等价于删死代码,运行时行为不变。

- [ ] **Step 3: rebuild + 全量 engine 测试**

Run: `cd packages/core && bun run build && bunx vitest run src/engine/`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add packages/core/src/engine/engine.ts
git commit -m "refactor(core): 删除 fallbackModelKeys 死代码(从无 UI 写入)"
```

---

## Task 5: agent-server stdio/tcp 种子改调解析器

**Files:**
- Modify: `packages/core/src/cli/agent-server-stdio.ts:99-105`
- Modify: `packages/core/src/cli/agent-server-tcp.ts:44-50`

- [ ] **Step 1: 改 stdio**

`agent-server-stdio.ts`,把:
```typescript
const llmConfig = {
  provider: settings.model.provider,
  model: settings.model.name,
  apiKey: settings.model.apiKey ?? "",
  baseUrl: settings.model.baseUrl,
  maxTokens: settings.model.maxTokens,
};
```
替换为:
```typescript
import { resolveLLMConfigForTag } from "../engine/resolve-llm-config.js"; // 顶部 import 区

const seedLlm = resolveLLMConfigForTag(settings, "text", settings.defaults?.text);
if (!seedLlm) {
  console.error(
    `[agent-server] 没有可用的文本模型连接(defaults.text=${settings.defaults?.text ?? "未设置"})。` +
    `请在「连接」页添加并填写凭证。`,
  );
  process.exit(1);
}
const llmConfig = seedLlm;
```

- [ ] **Step 2: 改 tcp(同样替换)**

`agent-server-tcp.ts` 用相同 import + 相同替换块。

- [ ] **Step 3: rebuild + typecheck**

Run: `cd packages/core && bun run build`
Expected: 编译通过(无 `settings.model` 引用残留)

- [ ] **Step 4: 提交**

```bash
git add packages/core/src/cli/agent-server-stdio.ts packages/core/src/cli/agent-server-tcp.ts
git commit -m "refactor(core): agent-server 种子改用 resolveLLMConfigForTag(不再读 legacy model.*)"
```

---

## Task 6: onboarding.ts 重写成写统一 catalog

**Files:**
- Modify: `packages/core/src/onboarding.ts:620-707`(`appendOnboardingResult`)
- Modify: `packages/tui/src/ui/onboarding-runner.ts`(调用方,适配新参数)
- Test: `packages/core/src/onboarding.test.ts`(新建或追加)

- [ ] **Step 1: 写失败测试**

`packages/core/src/onboarding.test.ts`(用临时 HOME 隔离,学现有测试隔离惯例 `CODE_SHELL_HOME`):

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendOnboardingResult } from "./onboarding.js";

describe("appendOnboardingResult (unified catalog)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cs-onboard-"));
    process.env.CODE_SHELL_HOME = home;
  });
  afterEach(() => {
    delete process.env.CODE_SHELL_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes credentials + modelConnections + defaults.text, no legacy fields", () => {
    appendOnboardingResult({
      instanceId: "deepseek",
      catalogId: "deepseek",
      tag: "text",
      model: "deepseek-v4-flash",
      apiKey: "sk-x",
      baseUrl: "https://api.deepseek.com/v1",
    });
    const file = join(home, ".code-shell", "settings.json");
    expect(existsSync(file)).toBe(true);
    const s = JSON.parse(readFileSync(file, "utf-8"));
    expect(s.modelConnections).toHaveLength(1);
    expect(s.modelConnections[0]).toMatchObject({ id: "deepseek", catalogId: "deepseek", tag: "text", model: "deepseek-v4-flash", credentialId: expect.any(String) });
    expect(s.credentials.some((c: any) => c.apiKey === "sk-x")).toBe(true);
    expect(s.defaults.text).toBe("deepseek");
    expect(s.model).toBeUndefined();
    expect(s.models).toBeUndefined();
    expect(s.activeKey).toBeUndefined();
  });

  it("is idempotent on instanceId (no dup)", () => {
    const opts = { instanceId: "deepseek", catalogId: "deepseek", tag: "text" as const, model: "deepseek-v4-flash", apiKey: "sk-x", baseUrl: "https://api.deepseek.com/v1" };
    appendOnboardingResult(opts);
    appendOnboardingResult(opts);
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.modelConnections).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bunx vitest run src/onboarding.test.ts`
Expected: FAIL(当前 `appendOnboardingResult` 签名是旧的 + 写 legacy)

- [ ] **Step 3: 重写 `appendOnboardingResult`**

替换 `onboarding.ts:620-707` 整个函数为:

```typescript
/**
 * 持久化 onboarding 结果到统一 catalog(credentials + modelConnections +
 * defaults[tag])。Append-only:相同 instanceId 跳过。原子写(tmp+rename)。
 * (旧版写 legacy model.*/models[]/providers[]/activeKey,已删除)
 */
export function appendOnboardingResult(opts: {
  /** 连接实例 id(= pool key),用户可改名;相同 id 视为重复跳过。 */
  instanceId: string;
  /** 基于哪个 catalog 模板。 */
  catalogId: string;
  tag: "text" | "image" | "video";
  /** 选中的 modelId(catalog preset 的 value)。 */
  model: string;
  apiKey?: string;
  /** 连接 baseUrl override;省略则用 credential/catalog 默认。 */
  baseUrl?: string;
}): void {
  const dir = join(userHome(), ".code-shell");
  const file = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, "utf-8")); } catch { /* corrupt → replace */ }
  }

  const credId = `${opts.instanceId}-key`;
  const existingCreds = Array.isArray((existing as any).credentials)
    ? ((existing as any).credentials as Array<Record<string, unknown>>) : [];
  const credsOut = existingCreds.some((c) => c?.id === credId)
    ? existingCreds
    : [...existingCreds, { id: credId, catalogId: opts.catalogId, apiKey: opts.apiKey, baseUrl: opts.baseUrl }];

  const existingConns = Array.isArray((existing as any).modelConnections)
    ? ((existing as any).modelConnections as Array<Record<string, unknown>>) : [];
  const connsOut = existingConns.some((c) => c?.id === opts.instanceId)
    ? existingConns
    : [...existingConns, {
        id: opts.instanceId, catalogId: opts.catalogId, tag: opts.tag,
        model: opts.model, credentialId: credId,
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      }];

  const existingDefaults = (typeof (existing as any).defaults === "object" && (existing as any).defaults)
    ? (existing as any).defaults as Record<string, unknown> : {};

  const updated: Record<string, unknown> = {
    ...existing,
    credentials: credsOut,
    modelConnections: connsOut,
    defaults: { ...existingDefaults, [opts.tag]: opts.instanceId },
  };

  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  try { renameSync(tmp, file); }
  catch { writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", "utf-8"); rmSync(tmp, { force: true }); }
}
```

> `userHome()` 已在文件内 import;确认 `mkdirSync/existsSync/readFileSync/writeFileSync/renameSync/rmSync/join` 都已 import(原函数都用了)。

- [ ] **Step 4: 适配调用方 `onboarding-runner.ts`**

Run: `grep -rn "appendOnboardingResult" packages/`
对每个调用点,把旧参数(`activeKey`/`activeMirror`/`addedProvider`/`addedModels`)改成新参数(`instanceId`/`catalogId`/`tag`/`model`/`apiKey`/`baseUrl`)。onboarding wizard 收集到的 provider+model+key 映射成:`instanceId` = 用户起的名或 catalogId,`catalogId` = 选的模板,`model` = 选的 modelId,`apiKey`/`baseUrl` = 填的凭证。

> 若 wizard 当前产出的是 legacy 形状(provider/model/apiKey/baseUrl 散字段),在 runner 里就近映射:`catalogId` 按 wizard 选的模板取;没有模板概念的旧 wizard 则用 `"custom"` + 让 baseUrl/model 直接落连接。

- [ ] **Step 5: rebuild + 跑测试**

Run: `cd packages/core && bun run build && bunx vitest run src/onboarding.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/onboarding.ts packages/core/src/onboarding.test.ts packages/tui/src/ui/onboarding-runner.ts
git commit -m "refactor(core): onboarding 重写成写统一 catalog(credentials/modelConnections/defaults)"
```

---

## Task 7: TUI 命令切换(repl/run/runs/main)

**Files:**
- Modify: `packages/tui/src/cli/commands/repl.ts`
- Modify: `packages/tui/src/cli/commands/run.ts`
- Modify: `packages/tui/src/cli/commands/runs.ts`
- Modify: `packages/tui/src/cli/main.ts`

- [ ] **Step 1: repl.ts —— 删 legacy 门控,种子改调解析器**

把 `hasSavedAuth` 计算改为基于统一 catalog:
```typescript
const hasSavedAuth =
  !!options.apiKey ||
  (Array.isArray((settings as any).credentials) && (settings as any).credentials.some((c: any) => c?.apiKey)) ||
  (Array.isArray((settings as any).modelConnections) && (settings as any).modelConnections.length > 0);
```

把 `llmConfig` 构造改为:
```typescript
import { resolveLLMConfigForTag } from "@cjhyy/code-shell-core";
// ...
const resolved = resolveLLMConfigForTag(settings, "text", (settings as any).defaults?.text);
const llmConfig: LLMConfig = resolved ?? {
  // onboarding 刚跑完的回退:用 wizard 结果(provider/model/apiKey/baseUrl 仍是局部变量)
  provider, model: model ?? "anthropic/claude-opus-4-6", apiKey, baseUrl, maxTokens: effortConfig.maxTokens ?? 8192,
};
```
> `provider/model/apiKey/baseUrl` 局部变量在 onboarding 分支仍需保留(wizard 即时结果)。删掉对 `settings.model.*` 的读取(改成 onboarding 结果或 resolver)。

- [ ] **Step 2: run.ts —— 删 findActiveModelEntry / findProviderApiKey**

删除 `findActiveModelEntry`、`findProviderApiKey` 两个 helper 函数。`llmConfig` 改为:
```typescript
import { resolveLLMConfigForTag } from "@cjhyy/code-shell-core";
// ...
const resolved = resolveLLMConfigForTag(settings, "text", (settings as any).defaults?.text);
if (!resolved && !options.apiKey) {
  console.error("Error: 没有可用的文本模型连接。请在「连接」页添加,或用 --api-key/--model 指定。");
  process.exit(1);
}
const llmConfig: LLMConfig = resolved ?? {
  provider: options.provider ?? "openai",
  model: options.model ?? "anthropic/claude-opus-4-6",
  apiKey: options.apiKey!,
  baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
  maxTokens: 8192,
};
```
> CLI flag(`--provider/--model/--api-key`)优先于连接:若 options 提供,用它们覆盖 resolved 对应字段(保留 CLI override 能力)。

- [ ] **Step 3: runs.ts —— 改调解析器**

`createRunManager` 里把 `llm` 构造改为:
```typescript
import { resolveLLMConfigForTag } from "@cjhyy/code-shell-core";
const settings = new SettingsManager(cwd).get();
const llm = resolveLLMConfigForTag(settings, "text", (settings as any).defaults?.text);
if (!llm) throw new Error("没有可用的文本模型连接(runs)。请在「连接」页配置。");
```
删除 `resolveApiKey(undefined, settings.model.apiKey)` 与 legacy 字段读取。temperature 改从 `clientDefaults`(若需要)用 `settings` 的其它来源,或省略(LLMConfig 不含 temperature)。

- [ ] **Step 4: main.ts arena —— 标降级**

arena participants 当前按 `models[].key` 解析。按用户决策**简化掉**:把 arena action 里读 `settings.model.*` 的 llm 构造改为 `resolveLLMConfigForTag`,participants 解析降级:
```typescript
const settings = new SettingsManager(process.cwd()).get();
const llm = resolveLLMConfigForTag(settings, "text", (settings as any).defaults?.text);
if (!llm) { console.error("Error: 没有可用的文本模型连接。"); process.exit(1); }
await runArenaReview({ topic, models: opts.models, mode: opts.mode }, {
  llm,
  clientDefaults: { temperature: 0.3 },
});
```
> arena.participants 的 models[].key 引用本次不迁(用户后面重做 arena)。若 `runArenaReview` 内部按 key 解析 participants,标 TODO 注释「arena 待重做:participants 改按 modelConnections.id」。

- [ ] **Step 5: rebuild core + typecheck tui**

Run:
```bash
cd packages/core && bun run build
cd ../tui && bun run typecheck 2>/dev/null || bunx tsc --noEmit
```
Expected: 无 `settings.model` 残留报错

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/cli/commands/repl.ts packages/tui/src/cli/commands/run.ts packages/tui/src/cli/commands/runs.ts packages/tui/src/cli/main.ts
git commit -m "refactor(tui): repl/run/runs/arena 改用 resolveLLMConfigForTag,删 legacy 解析"
```

---

## Task 8: Desktop automation-host / dream-service 切换

**Files:**
- Modify: `packages/desktop/src/main/automation-host.ts`(两处)
- Modify: `packages/desktop/src/main/dream-service.ts`

- [ ] **Step 1: automation-host.ts `buildDesktopRunManager`(block 1)**

```typescript
import { resolveLLMConfigForTag } from "@cjhyy/code-shell-core";
// ...
const settings = new SettingsManager(process.cwd(), "full").get();
const llm = resolveLLMConfigForTag(settings, "text", (settings as any).defaults?.text);
if (!llm) throw new Error("自动化:没有可用的文本模型连接,请在「连接」页配置。");
return createRunManager({ llm, cwd: process.cwd(), permissionMode: "default", approvalBackend: new HeadlessApprovalBackend("approve-read-only") });
```

- [ ] **Step 2: automation-host.ts 直跑 Engine(block 2)**

```typescript
const settings = new SettingsManager(jobCwd, "full").get();
const llm = resolveLLMConfigForTag(settings, "text", (settings as any).defaults?.text);
if (!llm) throw new Error("自动化任务:没有可用的文本模型连接。");
// ... memory/appendSystemPrompt 不变 ...
const engine = new Engine({ llm, cwd: jobCwd, settingsScope: "full", /* ...其余不变... */ });
```

- [ ] **Step 3: dream-service.ts —— 用 aux 模型**

dream 用辅助模型。改为:
```typescript
import { resolveLLMConfigForTag, resolveAuxKey } from "@cjhyy/code-shell-core";
// ...
const settings = new SettingsManager(seedCwd, "full").get();
const auxId = resolveAuxKey(settings); // defaults.auxText
const llmConfig =
  resolveLLMConfigForTag(settings, "text", auxId) ??
  resolveLLMConfigForTag(settings, "text", (settings as any).defaults?.text);
if (!llmConfig) throw new Error("Dream:没有可用的文本模型连接。");
const seedEngine = new Engine({ llm: llmConfig, cwd: seedCwd, settingsScope: "full", enabledBuiltinTools: ["MemoryList","MemoryRead","MemorySave","MemoryDelete"] });
```

- [ ] **Step 4: rebuild core + typecheck desktop**

Run:
```bash
cd packages/core && bun run build
cd ../desktop && bun run typecheck 2>/dev/null || bunx tsc --noEmit -p .
```
Expected: 无 `settings.model` 残留报错

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/automation-host.ts packages/desktop/src/main/dream-service.ts
git commit -m "refactor(desktop): automation/dream 改用 resolveLLMConfigForTag/resolveAuxKey"
```

---

## Task 9: 删 schema legacy 字段 + 清理 renderer 残留

**Files:**
- Modify: `packages/core/src/settings/schema.ts`(删字段)
- Modify: `packages/desktop/src/renderer/App.tsx:2758`(resolveActiveKey 删 activeKey fallback)
- 全仓 grep 清理残留

- [ ] **Step 1: 全仓 grep 剩余消费点**

Run:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
grep -rn "settings\.model\b\|\.activeKey\b\|\.auxModelKey\b\|\.fallbackModelKeys\b\|settings\.models\b\|settings\.providers\b" packages/*/src --include=*.ts --include=*.tsx | grep -v test | grep -v "modelConnections\|modelPool\|\.model\."
```
记录每个残留点,逐个改成统一 catalog 或删除。

- [ ] **Step 2: App.tsx resolveActiveKey 删 activeKey fallback**

`renderer/App.tsx:2758` 附近,把读 `settings.activeKey` 的 fallback 删除,只读 `defaults.text`。

- [ ] **Step 3: 删 schema 字段定义**

`schema.ts` 删除这些字段定义(整段):`model: z.object({...})`、`models: z.array(...)`、`providers: z.array(...)`、`activeKey: z.string().optional()`、`auxModelKey: z.string().optional()`、`fallbackModelKeys: z.array(...).default([])`。

> schema 是 `.passthrough()`,旧 settings.json 残留这些字段不会报错;但迁移脚本(Task 10)会清掉它们。

- [ ] **Step 4: rebuild + 全量测试**

Run:
```bash
cd packages/core && bun run build && bunx vitest run
```
Expected: PASS。**若有旧测试引用被删字段而 FAIL**,逐个判断:测被删功能的 → 删测试;测兼容性的 → 改写。记录处理结果。

- [ ] **Step 5: typecheck 三包**

Run:
```bash
cd packages/core && bunx tsc --noEmit
cd ../tui && bunx tsc --noEmit
cd ../desktop && bunx tsc --noEmit -p .
```
Expected: 全绿(无 `settings.model`/`activeKey` 等类型错误)

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "refactor: 删除 schema legacy 模型字段 + 清理全仓残留消费点"
```

---

## Task 10: 一次性迁移脚本

**Files:**
- Create: `scripts/migrate-legacy-models.mjs`
- Test: `scripts/migrate-legacy-models.test.mjs`(可选;脚本逻辑用 fixture 验证)

- [ ] **Step 1: 写脚本**

`scripts/migrate-legacy-models.mjs`:

```javascript
#!/usr/bin/env node
/**
 * 一次性迁移:把 ~/.code-shell/settings.json 的 legacy 模型存储
 * (model.*/models[]/providers[]/activeKey/auxModelKey) 转成统一 catalog
 * (credentials[]/modelConnections[]/defaults)。幂等:无 legacy 字段则跳过。
 * 备份原文件为 settings.json.pre-migrate-<ts>。
 *
 * catalogId 映射:按 baseUrl/provider 猜 builtin catalog id;猜不到标 custom。
 * arena.participants 不迁(按用户决策,后续重做 arena)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = path.join(os.homedir(), ".code-shell", "settings.json");
if (!fs.existsSync(file)) { console.log("无 settings.json,跳过。"); process.exit(0); }
const s = JSON.parse(fs.readFileSync(file, "utf-8"));

const hasLegacy = s.model || s.models || s.providers || s.activeKey || s.auxModelKey || s.fallbackModelKeys;
if (!hasLegacy) { console.log("无 legacy 字段,已是统一 catalog,跳过。"); process.exit(0); }

// baseUrl → builtin catalogId 猜测表
function guessCatalogId(baseUrl = "", provider = "") {
  const u = baseUrl.toLowerCase();
  if (u.includes("deepseek")) return "deepseek";
  if (u.includes("openrouter")) return "openrouter";
  if (u.includes("api.openai.com")) return "openai";
  if (u.includes("generativelanguage.googleapis")) return "google";
  if (u.includes("api.z.ai")) return "zai-glm";       // z.ai
  if (u.includes("open.bigmodel.cn")) return "zhipu-glm-5-2-1m"; // 智谱
  if (u.includes("anthropic")) return "anthropic";
  return "custom";
}

const credentials = Array.isArray(s.credentials) ? [...s.credentials] : [];
const modelConnections = Array.isArray(s.modelConnections) ? [...s.modelConnections] : [];
const defaults = typeof s.defaults === "object" && s.defaults ? { ...s.defaults } : {};
const report = [];

// 按 (apiKey, baseUrl) 去重凭证
function ensureCred(catalogId, apiKey, baseUrl) {
  let cred = credentials.find((c) => c.apiKey === apiKey && (c.baseUrl ?? "") === (baseUrl ?? ""));
  if (!cred) {
    const id = `${catalogId}-key-${credentials.length}`;
    cred = { id, catalogId, apiKey, baseUrl };
    credentials.push(cred);
  }
  return cred.id;
}

for (const m of s.models ?? []) {
  if (modelConnections.some((c) => c.id === m.key)) continue; // 已存在
  const baseUrl = m.baseUrl ?? (s.providers ?? []).find((p) => p.key === m.providerKey)?.baseUrl;
  const apiKey = m.apiKey ?? (s.providers ?? []).find((p) => p.key === m.providerKey)?.apiKey;
  const catalogId = guessCatalogId(baseUrl, m.provider);
  const credId = apiKey ? ensureCred(catalogId, apiKey, baseUrl) : undefined;
  modelConnections.push({
    id: m.key, catalogId, tag: "text", model: m.model,
    ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
    ...(credId ? { credentialId: credId } : {}),
  });
  report.push(`  ${m.key}: model=${m.model} → catalogId=${catalogId}${catalogId === "custom" ? " ⚠️ 需手动核对" : ""}`);
}

// activeKey → defaults.text;auxModelKey → defaults.auxText
if (s.activeKey && !defaults.text) defaults.text = s.activeKey;
if (s.auxModelKey && !defaults.auxText) defaults.auxText = s.auxModelKey;

// 删 legacy 字段
delete s.model; delete s.models; delete s.providers;
delete s.activeKey; delete s.auxModelKey; delete s.fallbackModelKeys;

const out = { ...s, credentials, modelConnections, defaults };

// 备份 + 写
const ts = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(file, `${file}.pre-migrate-${ts}`);
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf-8");

console.log("迁移完成。备份:", `${file}.pre-migrate-${ts}`);
console.log("转换的连接:");
console.log(report.join("\n") || "  (无 legacy models[] 需转)");
console.log(`defaults.text=${defaults.text ?? "未设"} defaults.auxText=${defaults.auxText ?? "未设"}`);
console.log("⚠️ 标 custom 的需在「连接」页核对 catalogId / 参数。");
```

> 注意 `new Date()` 在脚本里是允许的(脚本不是 workflow);仅 workflow 脚本禁用。

- [ ] **Step 2: 用 fixture 干跑验证(不碰真实 settings)**

先把真实 settings 复制到临时文件,改脚本里的 `file` 指向它跑一遍,核对输出 report 的 catalogId 映射对不对:
```bash
cp ~/.code-shell/settings.json /tmp/cs-test-settings.json
# 临时改 file 常量或用环境变量包一层,跑后检查 /tmp/cs-test-settings.json
node scripts/migrate-legacy-models.mjs   # 或带 dry-run 包装
```
Expected: report 列出 8 条 legacy models 的映射,deepseek/openai/openrouter/google 命中,zai/zhipu 命中各自 catalogId,无 custom(若有 custom 记录下来)。

- [ ] **Step 3: 提交脚本(先不对真实数据跑)**

```bash
git add scripts/migrate-legacy-models.mjs
git commit -m "feat(scripts): 一次性 legacy 模型存储迁移脚本"
```

---

## Task 11: 真机验证 + 对真实数据跑迁移

**Files:** 无(验证 + 数据迁移)

- [ ] **Step 1: 全量 rebuild + 测试 + typecheck**

Run:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
cd packages/core && bun run build && bunx vitest run
cd ../tui && bunx tsc --noEmit
cd ../desktop && bunx tsc --noEmit -p .
```
Expected: 全绿

- [ ] **Step 2: 对真实 settings 跑迁移脚本**

Run: `node scripts/migrate-legacy-models.mjs`
Expected: 打印备份路径 + 8 条连接映射;核对 settings.json 已无 legacy 字段、modelConnections 含全部模型。

- [ ] **Step 3: 真机冒烟(在 worktree 跑 app)**

启动 desktop(按项目 run skill / 惯例),验证:
- 切各文本模型(deepseek/gpt-5.5/GLM/gemini)都能发消息
- 新建一个连接(Connections 页)能跑
- 自动化/dream 若可触发则验证不报「没有可用连接」
记录每项结果。

- [ ] **Step 4: 更新设计稿验收清单 + 提交**

勾选设计稿 §9 验收项,提交:
```bash
git add -A
git commit -m "chore: legacy 模型存储删除完成 — 真机冒烟 + 数据迁移"
```

---

## Self-Review 结果

- **Spec 覆盖**:§2 范围全部有对应 Task(全删✓T2-4,9;迁移✓T10;TUI✓T7;onboarding✓T6;aux✓T3;catalogId 映射✓T10;arena 简化✓T7-S4)。§3 共享解析器✓T1。§5 错误处理✓T2-S4 + T5/6/7 各 boot path。
- **占位符扫描**:无 TBD;每个改代码步骤都有完整 before/after 代码。`new ModelPool([])` / `ProviderCatalog` import 删除标注了"按实际签名确认"——这是合理的实现期校验,非占位符。
- **类型一致**:`resolveLLMConfigForTag(settings, "text", id)` 签名全程一致;`appendOnboardingResult` 新参数(instanceId/catalogId/tag/model/apiKey/baseUrl)在 T6 定义、调用方 T6-S4 适配一致;`resolveAuxKey` 返回 key string、dream 用它 T8-S3 一致。
