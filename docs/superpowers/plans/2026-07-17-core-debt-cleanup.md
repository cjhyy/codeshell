# Core Debt Cleanup (工作流 C 剩余部分) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成设计文档 `docs/superpowers/specs/2026-07-16-optimization-sweep-2-design.md` 工作流 C 的剩余四项:守卫脚本死链修复(C4 余)、可直跑的 SDK examples(C3)、公共 API 收敛至 /internal(C2 余,0.8 breaking)、`runExclusive` 按阶段拆分至 <300 行(C1)。

**Architecture:** C4/C3/C2 是独立小改动,先做热身。C1 按 `runExclusive`(`packages/core/src/engine/engine.ts:1259-3045`,约 1787 行)的**真实阶段结构**拆为 7 个 `engine/run-*.ts` 模块(设计文档建议 4 个,实际结构见下),沿用既有拆分风格(`run-setup.ts` / `run-environment.ts` / `run-image-input.ts`:纯函数 + 显式参数对象 + `{ok:true}|{ok:false; result: EngineResult}` 早退联合),`runExclusive` 只保留编排骨架。每模块一个任务:先补/列行为快照测试 → 拆出 → 全量 `bun test packages/core` 绿 → commit。

**Tech Stack:** TypeScript (ESM, bun runtime), bun test, ESLint。仓库根 tsconfig paths 将 `@cjhyy/code-shell-core` 与 `@cjhyy/code-shell-core/internal` 直接映射到 `packages/core/src/index.ts` / `index.internal.ts`。

---

## 基线与硬约束(全程有效)

基线:branch `main`,HEAD `c366cc13`。**所有行号以此 HEAD 为准**;C1 各任务完成后行号会漂移,后续任务以任务内给出的「锚点代码」重新定位,行号仅作初始提示。

每个任务收尾都必须满足:

1. `bash scripts/check-no-engine-bypass.sh` → 输出 `OK: 'new Engine(' is confined to the protocol layer.`(**白名单一行都不许改**;因此 `new Engine(` 调用点必须留在 `packages/core/src/engine/engine.ts`,不得随拆分迁入新文件)。
2. `bun test packages/core/src/engine/engine-import-boundary.test.ts` 全绿(新拆模块**禁止** `import ... from "./engine.js"`)。
3. protocol 构造守卫(`packages/core/src/protocol/factories.ts` 及其相关测试)不动。
4. C1 行为零变化:`bun test packages/core` 全绿即验收;不改任何既有测试的断言(只允许新增测试、以及 Task 6 中 `resolveRunCwd` 测试 import 路径经 re-export 兼容后的零改动验证)。
5. `bun run lint` 通过;typecheck 按仓库惯例不作干净门禁但不得新增错误。
6. 每任务一个 conventional commit。

---

### Task 1: C4 — 修复 check-no-engine-bypass.sh 的死文档链接

**Files:**
- Modify: `scripts/check-no-engine-bypass.sh:10`
- Modify: `scripts/check-no-engine-bypass.sh:63`

背景:脚本两处引用 `docs/architecture/14-engine-call-paths.md`,该路径已不存在(现行 14 号章节是 `14-digital-human-and-pet.md`)。原 ADR 完整保留在 `docs/archive/architecture/14-engine-call-paths.md`;现行文档中描述 protocol 包装路径的是 `docs/architecture/04-protocol-and-sessions.md`。两处都改指 archive ADR,并在头注补一句现行章节指引。

- [ ] **Step 1: 确认死链与目标文档存在**

```bash
test -f docs/architecture/14-engine-call-paths.md && echo UNEXPECTED || echo "dead link confirmed"
test -f docs/archive/architecture/14-engine-call-paths.md && echo "archive ADR exists"
test -f docs/architecture/04-protocol-and-sessions.md && echo "living chapter exists"
```

预期:第一行 `dead link confirmed`,后两行文件存在。

- [ ] **Step 2: 修改第 10 行(头注)**

把

```
# that previously only worked from the REPL path. See P1 ADR
# docs/architecture/14-engine-call-paths.md.
```

改为

```
# that previously only worked from the REPL path. See P1 ADR
# docs/archive/architecture/14-engine-call-paths.md (living description:
# docs/architecture/04-protocol-and-sessions.md).
```

- [ ] **Step 3: 修改第 63 行(报错输出)**

把

```
  echo "See docs/architecture/14-engine-call-paths.md." >&2
```

改为

```
  echo "See docs/archive/architecture/14-engine-call-paths.md." >&2
```

- [ ] **Step 4: 验证**

```bash
bash scripts/check-no-engine-bypass.sh
grep -c "docs/archive/architecture/14-engine-call-paths.md" scripts/check-no-engine-bypass.sh
grep -c "docs/architecture/14-engine-call-paths.md" scripts/check-no-engine-bypass.sh
```

预期:`OK: 'new Engine(' is confined to the protocol layer.`;第一个 grep 输出 `2`;第二个 grep 输出 `2`(archive 路径包含旧路径为子串,属正常——用 `grep -n "docs/architecture/14"` 人工确认两处都带 `archive/` 前缀)。

- [ ] **Step 5: Commit**

```bash
git add scripts/check-no-engine-bypass.sh
git commit -m "chore(scripts): point engine-bypass guard at the archived call-paths ADR"
```

---

### Task 2: C3 — examples/01-minimal-agent.ts

**Files:**
- Create: `examples/01-minimal-agent.ts`

前置事实(已核对,执行时不需重查):根 `package.json` 的 `workspaces` 是 `["packages/*"]`,根 tsconfig `include` 只含 packages 下三个包,`eslint packages/`、`bun test`(只收 `*.test.ts`)都不覆盖 `examples/` —— **examples 不入任何构建链,无需排除方案**。仓内 `bun run examples/*.ts` 时 bun 读根 tsconfig 的 paths,把 `@cjhyy/code-shell-core` 解析到 `packages/core/src/index.ts`(源码直跑,无需先 build);仓外用户 `npm install @cjhyy/code-shell-core` 后同样代码可用。

Mock LLM 路径完全走公共 API(`LLMClientBase` + `registerProvider`,均在 `packages/core/src/index.ts` 稳定导出),写法对齐 `packages/core/src/engine/engine.permission-boundary.test.ts` 的 fake-client 模式(含「无 tools 的辅助调用返回 stop」守卫)。

- [ ] **Step 1: 写入 `examples/01-minimal-agent.ts`(完整内容)**

```ts
/**
 * 01 — Minimal agent: one Engine, one run, streamed output.
 *
 * Run with a real LLM (needs a key):
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/01-minimal-agent.ts
 *
 * Run without credentials (scripted mock LLM — demonstrates object assembly
 * and the streaming callback, no network):
 *   bun run examples/01-minimal-agent.ts --dry-run
 *
 * Inside this repo `bun install` is enough: the root tsconfig maps
 * @cjhyy/code-shell-core to packages/core/src, so no build step is needed.
 * Outside the repo, `npm install @cjhyy/code-shell-core` and the same code
 * works unchanged.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  HeadlessApprovalBackend,
  LLMClientBase,
  registerProvider,
  type CreateMessageOptions,
  type LLMResponse,
} from "@cjhyy/code-shell-core";

const dryRun = process.argv.includes("--dry-run");

if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    [
      "No ANTHROPIC_API_KEY in the environment — nothing was run.",
      "",
      "Either export a key:",
      "  export ANTHROPIC_API_KEY=sk-ant-...",
      "or run the credential-free mock demo:",
      "  bun run examples/01-minimal-agent.ts --dry-run",
    ].join("\n"),
  );
  process.exit(1);
}

if (dryRun) {
  // Keep example sessions/memory out of the user's real ~/.code-shell.
  process.env.CODE_SHELL_HOME = mkdtempSync(join(tmpdir(), "codeshell-example-01-"));

  // registerProvider is the same public seam used to plug any custom or
  // OpenAI-protocol-compatible provider into the engine.
  class MockLLMClient extends LLMClientBase {
    protected initClient(): void {}

    async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      this.recordUsage(usage, options);
      // Auxiliary calls (summaries/titles) come in without tools — answer
      // them tersely so the demo output stays focused on the main turn.
      if ((options.tools?.length ?? 0) === 0) {
        return { text: "mock summary", toolCalls: [], stopReason: "stop", usage };
      }
      return {
        text: "(mock) I would list the files here — run me with a real API key to see it live.",
        toolCalls: [],
        stopReason: "stop",
        usage,
      };
    }
  }
  registerProvider("example-mock", MockLLMClient);
}

const engine = new Engine({
  llm: dryRun
    ? { provider: "example-mock", model: "example-mock-1", apiKey: "unused" }
    : {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
  cwd: process.cwd(),
  // Headless approval — "approve-read-only" keeps this demo safe: reads are
  // approved, writes and shell commands are denied. See
  // examples/02-approval-flow.ts for a custom ApprovalBackend.
  approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
  headless: true,
});

const result = await engine.run(
  "List the files in the current directory and summarise their purpose in two sentences.",
  {
    onStream(event) {
      if (event.type === "text_delta") process.stdout.write(event.text);
      if (event.type === "tool_use_start") console.log("\n→ tool:", event.toolCall.toolName);
    },
  },
);

console.log("\n---");
console.log(
  `reason: ${result.reason} | turns: ${result.turnCount} | tokens: ${result.usage.totalTokens}`,
);
```

- [ ] **Step 2: 干跑验证**

```bash
bun run examples/01-minimal-agent.ts --dry-run
```

预期:stdout 打印 mock 文本,末尾 `reason: completed | turns: ...`,退出码 0。

- [ ] **Step 3: 无凭证指引验证**

```bash
env -u ANTHROPIC_API_KEY bun run examples/01-minimal-agent.ts; echo "exit=$?"
```

预期:打印指引(含 `--dry-run` 提示),`exit=1`,无堆栈。

- [ ] **Step 4: 确认不入构建链**

```bash
bun test examples 2>&1 | tail -1        # 预期: 0 tests(或 "no tests found" 类输出)
bun run lint                            # 预期: 通过(eslint 只扫 packages/)
```

- [ ] **Step 5: Commit**

```bash
git add examples/01-minimal-agent.ts
git commit -m "docs(examples): add 01-minimal-agent runnable SDK example"
```

---

### Task 3: C3 — examples/02-approval-flow.ts

**Files:**
- Create: `examples/02-approval-flow.ts`

要点:`ApprovalRequest`/`ApprovalResult` 类型不在公共根导出(它们在 /internal),示例用 `Parameters<ApprovalBackend["requestApproval"]>[0]` 从稳定接口派生,保持纯公共面。`EngineConfig.permissionMode` 显式传 `"default"`(engine 默认是 `acceptEdits`,会绕过编辑审批)。dry-run 的 mock 按调用序脚本化:第 1 次返回 `Write` 工具调用(被策略放行)、第 2 次返回危险 `Bash` 调用(被策略拒绝)、第 3 次返回总结文本;`ToolCall` 形状 `{ id, toolName, args }`、`stopReason: "tool_use"` 与 `engine.permission-boundary.test.ts` 一致。

- [ ] **Step 1: 写入 `examples/02-approval-flow.ts`(完整内容)**

```ts
/**
 * 02 — Approval flow: gate tool calls through your own ApprovalBackend.
 *
 * Run with a real LLM:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/02-approval-flow.ts
 *
 * Run without credentials (scripted mock LLM issues one approved Write and
 * one denied Bash call, so you can watch the policy fire):
 *   bun run examples/02-approval-flow.ts --dry-run
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  LLMClientBase,
  registerProvider,
  type ApprovalBackend,
  type CreateMessageOptions,
  type LLMResponse,
} from "@cjhyy/code-shell-core";

// Request/result shapes derived from the stable ApprovalBackend interface, so
// this file depends only on the public surface.
type ApprovalRequest = Parameters<ApprovalBackend["requestApproval"]>[0];
type ApprovalResult = Awaited<ReturnType<ApprovalBackend["requestApproval"]>>;

/**
 * Example policy: file edits (Write/Edit) are approved, everything else that
 * reaches the backend is denied. In production this is where you put your own
 * auth / audit / human-in-the-loop prompt.
 */
class PolicyApprovalBackend implements ApprovalBackend {
  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    const allow = req.toolName === "Write" || req.toolName === "Edit";
    console.log(
      `[approval] ${req.toolName} (risk=${req.riskLevel}) → ${allow ? "APPROVED" : "DENIED"} — ${req.description}`,
    );
    return allow
      ? { approved: true }
      : { approved: false, reason: "example policy: only Write/Edit are approved" };
  }
}

const dryRun = process.argv.includes("--dry-run");

if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    [
      "No ANTHROPIC_API_KEY in the environment — nothing was run.",
      "",
      "Either export a key:",
      "  export ANTHROPIC_API_KEY=sk-ant-...",
      "or run the credential-free mock demo:",
      "  bun run examples/02-approval-flow.ts --dry-run",
    ].join("\n"),
  );
  process.exit(1);
}

// The demo works in a scratch directory so the approved Write never touches
// your working tree.
const workDir = mkdtempSync(join(tmpdir(), "codeshell-example-02-"));

if (dryRun) {
  process.env.CODE_SHELL_HOME = mkdtempSync(join(tmpdir(), "codeshell-example-02-home-"));

  let mainCall = 0;
  class MockLLMClient extends LLMClientBase {
    protected initClient(): void {}

    async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      this.recordUsage(usage, options);
      if ((options.tools?.length ?? 0) === 0) {
        return { text: "mock summary", toolCalls: [], stopReason: "stop", usage };
      }
      mainCall += 1;
      if (mainCall === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-write-1",
              toolName: "Write",
              args: {
                file_path: join(workDir, "approval-demo.txt"),
                content: "hello from the approval-flow example\n",
              },
            },
          ],
          stopReason: "tool_use",
          usage,
        };
      }
      if (mainCall === 2) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-bash-1",
              toolName: "Bash",
              args: { command: `rm -rf ${workDir}` },
            },
          ],
          stopReason: "tool_use",
          usage,
        };
      }
      return {
        text: "(mock) Write was approved by the policy; the rm command was denied. Done.",
        toolCalls: [],
        stopReason: "stop",
        usage,
      };
    }
  }
  registerProvider("example-mock-approval", MockLLMClient);
}

const engine = new Engine({
  llm: dryRun
    ? { provider: "example-mock-approval", model: "example-mock-approval-1", apiKey: "unused" }
    : {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
  cwd: workDir,
  // "default" (NOT the engine's acceptEdits default) so file edits actually
  // route through the approval backend instead of being auto-accepted.
  permissionMode: "default",
  approvalBackend: new PolicyApprovalBackend(),
  headless: true,
});

const result = await engine.run(
  "Create a file named approval-demo.txt containing one greeting line, then try to delete this whole directory with rm. Report what was allowed and what was denied.",
  {
    onStream(event) {
      if (event.type === "text_delta") process.stdout.write(event.text);
    },
  },
);

console.log("\n---");
console.log(`reason: ${result.reason} | turns: ${result.turnCount}`);
console.log(`scratch dir (inspect the approved write): ${workDir}`);
```

- [ ] **Step 2: 干跑验证**

```bash
bun run examples/02-approval-flow.ts --dry-run
```

预期:两行 `[approval] ...` 日志(Write → APPROVED,Bash → DENIED),mock 总结文本,`reason: completed`,退出码 0。并且 `cat <打印的 scratch dir>/approval-demo.txt` 内容为 greeting 行(证明 Write 真的执行了)。

- [ ] **Step 3: 无凭证指引验证**

```bash
env -u ANTHROPIC_API_KEY bun run examples/02-approval-flow.ts; echo "exit=$?"
```

预期:指引文本 + `exit=1`。

- [ ] **Step 4: Commit**

```bash
git add examples/02-approval-flow.ts
git commit -m "docs(examples): add 02-approval-flow runnable SDK example"
```

---

### Task 4: C3 — examples/03-in-process-transport.ts + 根 README 链接

**Files:**
- Create: `examples/03-in-process-transport.ts`
- Modify: `README.md:172`(「Programmatic API」节末,`Everything is exported from the package root …` 段之后)

写法与 `packages/core/README.md` 的「Recommended public API (B3/§S7)」一节完全一致(`createServer`/`createClient`/`createInProcessTransport`;`client.run({ sessionId, task })`;`onStreamEvent(({ sessionId, event }) => …)`)。

- [ ] **Step 1: 写入 `examples/03-in-process-transport.ts`(完整内容)**

```ts
/**
 * 03 — Recommended public API (B3/§S7): createServer/createClient over an
 * in-process transport. This is the protocol-mediated construction path the
 * project tests, documents, and avoids breaking — prefer it over direct
 * `new Engine(...)` when embedding.
 *
 * Run with a real LLM:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/03-in-process-transport.ts
 *
 * Run without credentials:
 *   bun run examples/03-in-process-transport.ts --dry-run
 *
 * For an out-of-process worker, swap createInProcessTransport() for a
 * StdioTransport pair — the factories accept any Transport.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClient,
  createInProcessTransport,
  createServer,
  HeadlessApprovalBackend,
  LLMClientBase,
  registerProvider,
  type CreateMessageOptions,
  type LLMResponse,
} from "@cjhyy/code-shell-core";

const dryRun = process.argv.includes("--dry-run");

if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    [
      "No ANTHROPIC_API_KEY in the environment — nothing was run.",
      "",
      "Either export a key:",
      "  export ANTHROPIC_API_KEY=sk-ant-...",
      "or run the credential-free mock demo:",
      "  bun run examples/03-in-process-transport.ts --dry-run",
    ].join("\n"),
  );
  process.exit(1);
}

if (dryRun) {
  process.env.CODE_SHELL_HOME = mkdtempSync(join(tmpdir(), "codeshell-example-03-"));

  class MockLLMClient extends LLMClientBase {
    protected initClient(): void {}

    async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      this.recordUsage(usage, options);
      if ((options.tools?.length ?? 0) === 0) {
        return { text: "mock summary", toolCalls: [], stopReason: "stop", usage };
      }
      return {
        text: "(mock) README summary would stream here — run with a real key.",
        toolCalls: [],
        stopReason: "stop",
        usage,
      };
    }
  }
  registerProvider("example-mock-transport", MockLLMClient);
}

const [serverTransport, clientTransport] = createInProcessTransport();

const handle = createServer({
  transport: serverTransport,
  cwd: process.cwd(),
  llm: dryRun
    ? { provider: "example-mock-transport", model: "example-mock-transport-1", apiKey: "unused" }
    : {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
  permissionMode: "default",
  // Escape hatch for EngineConfig fields the flat options don't expose.
  engineOverrides: {
    headless: true,
    approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
  },
});

const client = createClient({ transport: clientTransport });

client.onStreamEvent(({ event }) => {
  if (event.type === "text_delta") process.stdout.write(event.text);
});

const result = await client.run({
  sessionId: "example-main",
  task: "Summarize README.md in three bullet points.",
});

console.log("\n---");
console.log(`reason: ${result.reason} | turns: ${result.turnCount}`);

handle.close();
client.close();
```

- [ ] **Step 2: 干跑验证**

```bash
bun run examples/03-in-process-transport.ts --dry-run
```

预期:mock 文本 + `reason: completed`,进程正常退出(`close()` 后无悬挂)。

- [ ] **Step 3: 根 README 补 examples 链接**

在 `README.md` 「## Programmatic API」节内、`Everything is exported from the package root — ...`(HEAD 第 172 行)段落之后、`## Configuration` 之前,插入:

```markdown
Runnable SDK examples live in [`examples/`](examples/) — each runs directly
with `bun run <file>` and supports `--dry-run` (scripted mock LLM) when no API
key is configured:

- [`examples/01-minimal-agent.ts`](examples/01-minimal-agent.ts) — one Engine, one run, streamed output
- [`examples/02-approval-flow.ts`](examples/02-approval-flow.ts) — a custom `ApprovalBackend` gating tool calls
- [`examples/03-in-process-transport.ts`](examples/03-in-process-transport.ts) — the recommended `createServer` / `createClient` factory pair
```

- [ ] **Step 4: 全量回归**

```bash
bun run lint
bash scripts/check-no-engine-bypass.sh
```

预期:两者通过(examples 不被 lint 扫描;新文件里的 `new Engine(` 在 `examples/`,不在脚本扫描的三个 `packages/*/src` 树内,不触发守卫)。

- [ ] **Step 5: Commit**

```bash
git add examples/03-in-process-transport.ts README.md
git commit -m "docs(examples): add 03-in-process-transport example and README links"
```

---

### Task 5: C2 — installer/marketplace/onboarding/updater 导出迁往 /internal(0.8 breaking)

**Files:**
- Modify: `packages/core/src/index.ts:368-415,492-495,633-652,656-664`(删除迁移块)
- Modify: `packages/core/src/index.internal.ts:243`(文件尾追加新分区)
- Modify: `packages/core/src/index.exports.test.ts:22-232`(新分区清单 + 负面断言)
- Modify: `packages/core/README.md:150-163`(Treat as internal / Stability)
- Modify(消费方,共 13 个文件):
  - `packages/tui/src/cli/commands/plugin.ts:1-3`
  - `packages/tui/src/cli/commands/builtin/plugin-handler.ts:1-8`
  - `packages/tui/src/cli/commands/builtin/core-commands.ts:9`
  - `packages/tui/src/cli/commands/builtin/utility-commands.ts:202-203`
  - `packages/tui/src/cli/main.ts:1-12`
  - `packages/tui/src/cli/output/terminal-ui.ts:6`
  - `packages/tui/src/ui/components/Banner.tsx:6`
  - `packages/tui/src/ui/components/UpdateBanner.tsx:1-5`
  - `packages/tui/src/ui/components/OnboardingPrompt.tsx:4-8`
  - `packages/desktop/src/main/bootstrap-core-plugins.ts:4`
  - `packages/desktop/src/main/marketplace-service.ts:1-2`
  - `packages/desktop/src/main/plugins-service.ts:1-3`
  - `packages/desktop/src/main/seed-defaults.ts:7`
  - `packages/desktop/src/preload/types.d.ts:7-20`

路线:与 2026-07-15 已完成的 host-only 面收敛一致——**直接迁移,不留 @deprecated 过渡**(设计文档原方案是 @deprecated,但同批 host-only 面已走直迁路线且 0.7.1 后未发版,保持一致;commit message 与 core README 注明 0.8 breaking)。

**迁移符号清单(runtime 46 个 + 伴随类型)**,全部从 `index.ts` 删除、加入 `index.internal.ts`:

- installer(`plugins/installer/*`):`installPluginFromPath`(+`InstallPluginFromPathOptions`)、`installPluginFromSource`、`installPluginFromNpm`、`resolveNpmPlugin`、`downloadVerifiedNpmTarball`、`NPM_PUBLIC_REGISTRY`、`MAX_NPM_METADATA_BYTES`(+`NpmPluginFetch`/`NpmPluginInstallOptions`/`ResolvedNpmPlugin`)、`extractNpmTar`、`gunzipNpmTarball`、`MAX_NPM_TARBALL_BYTES`、`MAX_NPM_TAR_EXTRACTED_BYTES`、`MAX_NPM_TAR_FILE_BYTES`、`MAX_NPM_TAR_ENTRIES`、`MAX_NPM_TAR_PATH_BYTES`、`MAX_NPM_TAR_DEPTH`、`installLocalPlugin`、`installPluginFromArchive`、`installReviewedLocalPlugin`、`previewLocalPlugin`、`LocalPluginReviewChangedError`(+全部 `LocalPlugin*Preview*` 类型)、`parseSource`、`parseNpmPluginSource`(+`ParsedSource`)、`detectPluginFormat`、`uninstallPluginByName`、`listInstalledPlugins`(+`PluginListRow`)、`updatePluginByName`(+`UpdateResult`)、`checkPluginUpdate`(+`UpdateCheck`)
- legacy marketplace installer(`plugins/pluginInstaller.js`):`installPlugin`、`uninstallPlugin`、`listInstalled`
- marketplace:`addMarketplace`、`refreshMarketplace`、`removeMarketplace`、`listMarketplaces`、`loadMarketplace`、`parseMarketplaceInput`、`deriveMarketplaceName`
- onboarding:`hasApiKey`、`resolveApiKey`、`appendOnboardingResult`、`detectEnvKeys`(+`OnboardingResult`)
- updater:`getCurrentVersion`、`checkForUpdate`、`scheduleAutoInstallOnExit`、`getUpdateAvailable`、`getAutoUpdateDisabledReason`(+`UpdateInfo`)

**保留在公共根**(运行时插件面,engine/hosts 在会话中消费,不属安装器):`PluginInstallError` 与 manifest schema 块(L416-433)、`normalizePluginManifest`/`readCanonicalPluginManifest`、plugin MCP/hook 审批族、`pluginsRoot`、`resolveSafePluginPath`、`describePluginContent`、`loadPluginCatalog` 族、`instantiatePluginAutomationTemplate`、`pluginAgentDirs`、`appendInstallEntry`/`pluginInstallKey`/`removeInstallEntries`、`readInstalledPlugins`、`pluginCommandsLoader` 块、`uninstallPluginByName` **不保留**(上面已迁)。

- [ ] **Step 1: 从 `packages/core/src/index.ts` 删除五个块**

依次删除(以 HEAD 行号;内容以「迁移符号清单」为准逐一核对):

1. L368-415:`// ─── Plugin installer (CC + Codex) ───…` 头注 + `installPluginFromPath` 至 `detectPluginFormat` 的全部 export 语句。在原位置(L416 的 `CodexPluginManifest` 块之前)补一行新头注,让留下的 manifest/审批导出保有分区名:

```ts
// ─── Plugin manifests, trust & catalog (runtime surface) ────────
```

2. L492-495:`uninstallPluginByName`、`listInstalledPlugins`、`updatePluginByName`、`checkPluginUpdate` 四条 export。
3. L633-641:`// ─── Onboarding ───…` 整节。
4. L643-652:`// ─── Updater ───…` 整节。
5. L656-664:`Plugins` 节内 `installPlugin, uninstallPlugin, listInstalled`、marketplace 五连、`parseMarketplaceInput, deriveMarketplaceName` 三条 export(保留 L654 节头与 L665-674 的 `pluginCommandsLoader` 块)。

- [ ] **Step 2: 在 `packages/core/src/index.internal.ts` 文件尾追加新分区(完整内容)**

```ts
// ─── Host assembly: plugin installer / marketplace / onboarding / updater ──
// Moved off the public root barrel in 0.8 (breaking): these are host
// assembly surfaces (TUI/desktop install flows, self-update, first-run
// onboarding), not part of the embeddable agent SDK. External embedders
// should drive installs through their own host layer.

export {
  installPluginFromPath,
  type InstallPluginFromPathOptions,
} from "./plugins/installer/install.js";
export { installPluginFromSource } from "./plugins/installer/installFromSource.js";
export {
  installPluginFromNpm,
  resolveNpmPlugin,
  downloadVerifiedNpmTarball,
  NPM_PUBLIC_REGISTRY,
  MAX_NPM_METADATA_BYTES,
  type NpmPluginFetch,
  type NpmPluginInstallOptions,
  type ResolvedNpmPlugin,
} from "./plugins/installer/installFromNpm.js";
export {
  extractNpmTar,
  gunzipNpmTarball,
  MAX_NPM_TARBALL_BYTES,
  MAX_NPM_TAR_EXTRACTED_BYTES,
  MAX_NPM_TAR_FILE_BYTES,
  MAX_NPM_TAR_ENTRIES,
  MAX_NPM_TAR_PATH_BYTES,
  MAX_NPM_TAR_DEPTH,
} from "./plugins/installer/npmTar.js";
export {
  installLocalPlugin,
  installPluginFromArchive,
} from "./plugins/installer/installFromArchive.js";
export {
  installReviewedLocalPlugin,
  previewLocalPlugin,
  LocalPluginReviewChangedError,
  type LocalPluginHookPreview,
  type LocalPluginAutomationTemplatePreview,
  type LocalPluginInterfacePreview,
  type LocalPluginMcpPreview,
  type LocalPluginPreview,
  type LocalPluginPreviewWarning,
  type LocalPluginPreviewWarningKind,
} from "./plugins/installer/preview.js";
export {
  parseSource,
  parseNpmPluginSource,
  type ParsedSource,
} from "./plugins/installer/parseSource.js";
export { detectPluginFormat } from "./plugins/installer/detectFormat.js";
export { uninstallPluginByName } from "./plugins/installer/uninstall.js";
export { listInstalledPlugins, type PluginListRow } from "./plugins/installer/list.js";
export { updatePluginByName, type UpdateResult } from "./plugins/installer/update.js";
export { checkPluginUpdate, type UpdateCheck } from "./plugins/installer/checkUpdate.js";
export { installPlugin, uninstallPlugin, listInstalled } from "./plugins/pluginInstaller.js";
export {
  addMarketplace,
  refreshMarketplace,
  removeMarketplace,
  listMarketplaces,
  loadMarketplace,
} from "./plugins/marketplaceManager.js";
export { parseMarketplaceInput, deriveMarketplaceName } from "./plugins/parseMarketplaceInput.js";
export {
  hasApiKey,
  resolveApiKey,
  appendOnboardingResult,
  detectEnvKeys,
  type OnboardingResult,
} from "./onboarding.js";
export {
  getCurrentVersion,
  checkForUpdate,
  scheduleAutoInstallOnExit,
  getUpdateAvailable,
  getAutoUpdateDisabledReason,
  type UpdateInfo,
} from "./updater.js";
```

- [ ] **Step 3: 更新 `packages/core/src/index.exports.test.ts`**

3a. 在 `expectedRuntimeExportsByPartition`(L22-174)的 `sourcesProfilesCapabilityControl` 之后新增分区:

```ts
  hostAssembly: [
    "installPluginFromPath",
    "installPluginFromSource",
    "installPluginFromNpm",
    "resolveNpmPlugin",
    "downloadVerifiedNpmTarball",
    "NPM_PUBLIC_REGISTRY",
    "MAX_NPM_METADATA_BYTES",
    "extractNpmTar",
    "gunzipNpmTarball",
    "MAX_NPM_TARBALL_BYTES",
    "MAX_NPM_TAR_EXTRACTED_BYTES",
    "MAX_NPM_TAR_FILE_BYTES",
    "MAX_NPM_TAR_ENTRIES",
    "MAX_NPM_TAR_PATH_BYTES",
    "MAX_NPM_TAR_DEPTH",
    "installLocalPlugin",
    "installPluginFromArchive",
    "installReviewedLocalPlugin",
    "previewLocalPlugin",
    "LocalPluginReviewChangedError",
    "parseSource",
    "parseNpmPluginSource",
    "detectPluginFormat",
    "uninstallPluginByName",
    "listInstalledPlugins",
    "updatePluginByName",
    "checkPluginUpdate",
    "installPlugin",
    "uninstallPlugin",
    "listInstalled",
    "addMarketplace",
    "refreshMarketplace",
    "removeMarketplace",
    "listMarketplaces",
    "loadMarketplace",
    "parseMarketplaceInput",
    "deriveMarketplaceName",
    "hasApiKey",
    "resolveApiKey",
    "appendOnboardingResult",
    "detectEnvKeys",
    "getCurrentVersion",
    "checkForUpdate",
    "scheduleAutoInstallOnExit",
    "getUpdateAvailable",
    "getAutoUpdateDisabledReason",
  ],
```

3b. 在 `hostOnlySamples`(L180-203)追加负面断言样本(公共根不得再出现):

```ts
  "installPluginFromPath",
  "installPlugin",
  "previewLocalPlugin",
  "uninstallPluginByName",
  "addMarketplace",
  "parseMarketplaceInput",
  "resolveApiKey",
  "detectEnvKeys",
  "getCurrentVersion",
  "checkForUpdate",
```

3c. 头注(L18-21)补一句:`Host-assembly surfaces (installer/marketplace/onboarding/updater) moved here in 0.8.`

- [ ] **Step 4: 迁移 TUI 消费方(9 个文件)**

每处只改 import 来源,调用代码零改动。

`packages/tui/src/cli/commands/plugin.ts`(原 L1-3 单块):

```ts
import { PluginInstallError } from "@cjhyy/code-shell-core";
import {
  installPluginFromPath,
  installPluginFromNpm,
  installPluginFromSource,
  parseSource,
  uninstallPluginByName,
  listInstalledPlugins,
  updatePluginByName,
} from "@cjhyy/code-shell-core/internal";
```

`packages/tui/src/cli/commands/builtin/plugin-handler.ts`:root 三个块中移走 `parseMarketplaceInput`、`deriveMarketplaceName`、`addMarketplace`、`listMarketplaces`、`removeMarketplace`、`installPlugin`、`uninstallPlugin`、`listInstalled`(root 保留 `SettingsManager`、`invalidateSkillCache`、`approvePluginHooks`、`approvePluginMcp`、`listPluginMcpTrust`、`listPluginHooks`、`reviewPluginHooks`、`revokePluginMcp`、`revokePluginHooks`、`loadPluginAutomationTemplateContributions`、`instantiatePluginAutomationTemplate`),移走的符号并入已有的 `@cjhyy/code-shell-core/internal` import(现有成员 `computeEffectiveDisabledLists, cronScheduler, type CronScheduler`)。

`packages/tui/src/cli/commands/builtin/core-commands.ts:9`:

```ts
import { resolveApiKey } from "@cjhyy/code-shell-core/internal";
```

`packages/tui/src/cli/commands/builtin/utility-commands.ts:202-203`(`/update` 命令的动态 import):

```ts
        const { getCurrentVersion, getUpdateAvailable, getAutoUpdateDisabledReason } =
          await import("@cjhyy/code-shell-core/internal");
```

(同文件 L46-52 `/undo` 的动态 import 内符号 `FileHistory` 等全部留在公共根,不动。)

`packages/tui/src/cli/main.ts`:从 root 块(L5-8)移除 `getCurrentVersion`,新增:

```ts
import { getCurrentVersion } from "@cjhyy/code-shell-core/internal";
```

`packages/tui/src/cli/output/terminal-ui.ts:6` 与 `packages/tui/src/ui/components/Banner.tsx:6`:

```ts
import { getCurrentVersion } from "@cjhyy/code-shell-core/internal";
```

`packages/tui/src/ui/components/UpdateBanner.tsx`(原 L1-5 root 块整体换源):

```ts
import {
  checkForUpdate,
  getCurrentVersion,
  getUpdateAvailable,
  scheduleAutoInstallOnExit,
  type UpdateInfo,
} from "@cjhyy/code-shell-core/internal";
```

`packages/tui/src/ui/components/OnboardingPrompt.tsx`(原 root 块 L5-7 换源;与既有 internal type import 并存或合并):

```ts
import {
  type OnboardingResult,
  detectEnvKeys,
  appendOnboardingResult,
} from "@cjhyy/code-shell-core/internal";
```

- [ ] **Step 5: 迁移 desktop 消费方(5 个文件)**

`packages/desktop/src/main/bootstrap-core-plugins.ts:4` 拆为:

```ts
import { readInstalledPlugins, pluginInstallKey } from "@cjhyy/code-shell-core";
import { installPlugin } from "@cjhyy/code-shell-core/internal";
```

`packages/desktop/src/main/marketplace-service.ts`(原单块)拆为:

```ts
import { invalidateSkillCache } from "@cjhyy/code-shell-core";
import {
  listMarketplaces,
  loadMarketplace,
  addMarketplace,
  refreshMarketplace,
  removeMarketplace,
  installPlugin,
  installReviewedLocalPlugin,
  LocalPluginReviewChangedError,
  previewLocalPlugin,
  parseMarketplaceInput,
  deriveMarketplaceName,
  type LocalPluginPreview,
} from "@cjhyy/code-shell-core/internal";
```

`packages/desktop/src/main/plugins-service.ts` 拆为(root 保留运行时目录/清单面):

```ts
import {
  loadPluginCatalog,
  loadPluginPanelContributions,
  describePluginContent,
  listPluginMcpTrust,
  type PluginContentInventory,
  type PluginMcpTrustEntry,
  SettingsManager,
} from "@cjhyy/code-shell-core";
import {
  computeEffectiveDisabledLists,
  uninstallPlugin,
  uninstallPluginByName,
  updatePluginByName,
  checkPluginUpdate,
  type UpdateResult,
  type UpdateCheck,
} from "@cjhyy/code-shell-core/internal";
```

`packages/desktop/src/main/seed-defaults.ts:7`:

```ts
import { addMarketplace } from "@cjhyy/code-shell-core/internal";
```

`packages/desktop/src/preload/types.d.ts`:从 L7-19 root type import 中移除 `LocalPluginPreview`,并入 L20:

```ts
import type {
  ApprovalRequest,
  ReasoningControl,
  LocalPluginPreview,
} from "@cjhyy/code-shell-core/internal";
```

(该文件 L83 的 `export type { LocalPluginPreview };` 及 renderer 侧经 `../../preload/types` 的消费不需要改。)

- [ ] **Step 6: 残留扫描**

用 perl 抽出所有仍从公共根 `"@cjhyy/code-shell-core"` import 的符号清单(覆盖多行 import),与迁移清单求交集:

```bash
perl -0777 -ne 'while (/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\@cjhyy\/code-shell-core"/gs) { my $s=$1; $s =~ s/\s+/ /g; print "$ARGV: $s\n"; }' \
  $(grep -rl --include="*.ts" --include="*.tsx" '@cjhyy/code-shell-core"' packages/tui/src packages/desktop/src packages/pet/src packages/arena/src packages/server/src packages/web/src packages/chat/src packages/coding/src) \
  | grep -wE "installPluginFromPath|installPluginFromSource|installPluginFromNpm|installLocalPlugin|installPluginFromArchive|installReviewedLocalPlugin|previewLocalPlugin|LocalPluginReviewChangedError|LocalPluginPreview|parseSource|parseNpmPluginSource|detectPluginFormat|uninstallPluginByName|listInstalledPlugins|updatePluginByName|checkPluginUpdate|installPlugin|uninstallPlugin|listInstalled|addMarketplace|refreshMarketplace|removeMarketplace|listMarketplaces|loadMarketplace|parseMarketplaceInput|deriveMarketplaceName|hasApiKey|resolveApiKey|appendOnboardingResult|detectEnvKeys|OnboardingResult|getCurrentVersion|checkForUpdate|scheduleAutoInstallOnExit|getUpdateAvailable|getAutoUpdateDisabledReason|UpdateInfo|UpdateResult|UpdateCheck" \
  || echo CLEAN
```

预期:`CLEAN`。同时确认动态 import 与非 packages 消费者无残留:

```bash
grep -rn 'await import("@cjhyy/code-shell-core")' packages/tui/src packages/desktop/src   # 预期:仅 utility-commands.ts /undo 一处(FileHistory 等公共符号,合法)
grep -nE "getCurrentVersion|installPlugin|addMarketplace|resolveApiKey" packages/core/src/index.extension.ts scripts/smoke-core-exports.mjs scripts/smoke-core-harness.mjs || echo CLEAN
```

- [ ] **Step 7: core README 稳定面同步**

`packages/core/README.md`:

1. 「### Treat as internal」段(L150-157)首句后追加:

```markdown
In 0.8 the plugin installer / marketplace / onboarding / self-updater exports
(`installPluginFromPath`, `installPlugin`, `addMarketplace`, `resolveApiKey`,
`checkForUpdate`, …) moved off this root entry to
`@cjhyy/code-shell-core/internal` — they are host-assembly surfaces for the
in-repo TUI/desktop apps, not part of the embeddable agent SDK.
```

2. 「## Stability」段(L159-163)末尾追加:

```markdown
**Breaking in 0.8:** host-assembly exports (installer/marketplace/onboarding/
updater) left the root entry; import them from
`@cjhyy/code-shell-core/internal` if you must (no stability promise there).
```

- [ ] **Step 8: 验证**

```bash
bun test packages/core/src/index.exports.test.ts
bun test
bun run lint
bash scripts/check-no-engine-bypass.sh
cd packages/desktop && bun run typecheck && cd ../..
```

预期:全部通过;`index.exports.test.ts` 的分区全集断言(`Object.keys(internalApi).sort()` 等于清单)与新负面断言绿。

- [ ] **Step 9: Commit(注明 breaking)**

```bash
git add packages/core/src/index.ts packages/core/src/index.internal.ts packages/core/src/index.exports.test.ts packages/core/README.md packages/tui/src packages/desktop/src
git commit -m "refactor(core)!: move installer/marketplace/onboarding/updater exports to /internal

BREAKING CHANGE (0.8): installPluginFromPath/Npm/Source/Archive, marketplace
management, onboarding helpers and the self-updater no longer ship on the
public root entry of @cjhyy/code-shell-core. They are host assembly surfaces;
in-repo hosts import them from @cjhyy/code-shell-core/internal. Follows the
same direct-migration route as the 2026-07-15 host-only convergence (no
@deprecated transition — 0.7.1 was the last release with the old surface)."
```

---

## C1 — 拆分 runExclusive(Task 6-13)

### runExclusive 真实阶段结构(以 HEAD 通读结果为准)

| # | 阶段(HEAD 行号) | 内容 | 去向 |
|---|---|---|---|
| 1 | L1259-1370 | session kind/workspaceProfile 校验、行为 profile + profileParams、permission/plan mode、workspace resume(两个早退)、cwd 解析、`resolveRunProfileState` | **run-workspace.ts**(Task 6) |
| 2 | L1372-1424 | `wrappedOnStream`(task_update/goal_progress 截听)、`prepareRunImageInput`、pasted-noise 早退 | 留在 engine(输入准备已被 `run-image-input.ts` 抽走,余量 ~50 行) |
| 3 | L1426-1530 | sandbox 解析、`createSubAgentSpawner`(**`new Engine(` 在此,必须留在 engine.ts**)、ToolContext 组装 | spawner+sandbox 留 engine;ToolContext 组装 → **run-tooling.ts**(Task 8) |
| 4 | L1532-1718 | 会话 create/resume、clientMessageId 去重(早退)、user message 追加、summary、turnSeq、toolCtx 会话戳 | **run-session-open.ts**(Task 7);toolCtx 戳留 engine |
| 5a | L1720-1790 | runWithSid 开始、session_start/prompt_submit 钩子、updatedPrompt 重写 | 留在 engine(`this.emitHook` 编排) |
| 5b | L1792-1865 | ContextManager + anchor 播种、ctx seed、session_started 事件、todo 快照回放 | **run-context.ts**(Task 9);事件发射留 engine |
| 5c | L1867-1933 | LLM client 预热、permission classifier + 审批监听、ToolExecutor + guards | **run-tooling.ts**(Task 8) |
| 5d | L1935-1979 | goal 可见性预判、disabled lists、PromptComposer(已有 `buildPromptComposerConfig`) | 留在 engine(~40 行胶水) |
| 5e | L1981-2003 | MCP connectAll | **run-tooling.ts**(Task 8) |
| 5f | L2005-2145 | builtin override / MCP 可见性 / feature flags / 动态 tool defs / plan-mode 过滤 | **run-tooling.ts**(Task 8) |
| 5g | L2147-2193 | await 三并行、runtimeContext 拼接、userContext/提醒/volatile 消息组装 | 纯函数部分 → **run-context.ts**(Task 9) |
| 5h | L2195-2341 | usage 记账闭包、ModelFacade + aux summarize + goal 预算护栏 | **run-accounting.ts**(Task 10) |
| 5i | L2343-2366 | fileHistory hook 注册、on_agent_start | 留在 engine |
| 5j | L2368-2514 | goal 归一化/持久化/arm、GoalStopHook 创建注册 | **run-goal.ts**(Task 11) |
| 5k | L2516-2709 | compaction 缓冲、TurnLoop 构造(大 options 对象) | 留在 engine(编排骨架本体) |
| 5l | L2711-2846 | `applyGoalTermination`、turnLoop.run、headless 后台代理排水、finally 清理 | applyGoalTermination → **run-goal.ts**;排水 → **run-finalize.ts**(Task 12);try/finally 骨架留 engine |
| 5m | L2847-3009 | 结果缓存、on_session_end、memory pipeline、session title、终态持久化、结果组装 | **run-finalize.ts**(Task 12) |
| 6 | L3011-3044 | 生命周期 catch → model_error 终态 | **run-finalize.ts**(Task 12) |

**与设计文档四模块建议的差异**(实施时以本表为准):`run-input.ts` 不再新建——图片/prompt 输入准备已存在于 `run-image-input.ts`,剩余的「输入」工作实为会话打开,故改名 `run-session-open.ts`;另外要达成 <300 行必须再拆 `run-context.ts`、`run-accounting.ts`、`run-finalize.ts` 三个设计文档未列的模块。`run-workspace.ts`、`run-tooling.ts`、`run-goal.ts` 与建议一致。

**通用拆分规约(每个 C1 任务都遵守):**

- 新模块禁止 `import ... from "./engine.js"`(boundary test);需要 Engine 私有方法/字段的,一律以回调或值经参数对象传入。
- `new Engine(` 不得出现在新模块(bypass 白名单不变)。
- 移动均为**逐行原样搬运**,只做「`this.X` → 参数」的机械替换(每任务给出替换表);不重排逻辑、不改字符串、不改日志 key。
- engine.ts 顶部 import:把仅被搬走代码使用的 import 迁到新模块;`bun run lint` 的 unused-import 报错就是核对清单。
- 每任务验证序列(下文简称「**C1 验证**」):

```bash
bun test packages/core/src/engine
bun test packages/core
bun test packages/core/src/engine/engine-import-boundary.test.ts
bash scripts/check-no-engine-bypass.sh
bun run lint
```

---

### Task 6: C1 模块 1 — run-workspace.ts(kind/profile/权限模式/workspace resume/cwd)

**Files:**
- Create: `packages/core/src/engine/run-workspace.ts`
- Create: `packages/core/src/engine/engine.session-kind.test.ts`
- Modify: `packages/core/src/engine/engine.ts:226-243`(`resolveRunCwd` 迁出后 re-export)、`engine.ts:1259-1370`(搬运源)

既有行为快照依据:`engine.resolve-cwd.test.ts`(cwd 四级优先级)、`engine.workspace-profile-session.test.ts`(profile 固定/mismatch)、`engine.permission-rules.test.ts` + `engine.quick-chat-restricted.test.ts`(permission/plan mode 解析路径)。**缺口**:session kind mismatch 无测试,先补。

- [ ] **Step 1: 写失败前的行为快照测试 `engine.session-kind.test.ts`(完整内容)**

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";

const provider = "fake-session-kind";

class SessionKindClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return { text: "ok", toolCalls: [], stopReason: "stop", usage };
  }
}
registerProvider(provider, SessionKindClient);

function makeEngine(dir: string): Engine {
  const engine = new Engine({
    llm: {
      provider,
      model: `${provider}-${Date.now()}-${Math.random()}`,
      apiKey: "test",
    } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    headless: true,
  });
  (engine as unknown as { hooks: { clear(): void } }).hooks.clear();
  return engine;
}

describe("runExclusive session-kind pinning (run-workspace behavior snapshot)", () => {
  it("rejects a resume whose requested kind differs from the persisted kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-session-kind-"));
    try {
      const engine = makeEngine(dir);
      await engine.run("first turn", { sessionId: "s-kind-pin", cwd: dir });
      await expect(
        engine.run("second turn", {
          sessionId: "s-kind-pin",
          cwd: dir,
          kind: "quick-chat" as never,
        }),
      ).rejects.toThrow(/session kind mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses the persisted kind when a resume omits options.kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-session-kind-"));
    try {
      const engine = makeEngine(dir);
      const first = await engine.run("first turn", { sessionId: "s-kind-reuse", cwd: dir });
      expect(first.reason).toBe("completed");
      const second = await engine.run("second turn", { sessionId: "s-kind-reuse", cwd: dir });
      expect(second.reason).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行新测试,确认对现状为绿(快照基线)**

```bash
bun test packages/core/src/engine/engine.session-kind.test.ts
```

预期:2 pass(这是「拆分前后行为一致」的快照,不是红-绿 TDD;必须在拆分前先绿)。

- [ ] **Step 3: 创建 `run-workspace.ts`(骨架完整,函数体为 engine.ts L1263-1370 原样搬运)**

```ts
/**
 * Run-workspace resolution — the pre-session phase of Engine.runExclusive:
 * pins session kind + workspace profile against persisted state, resolves the
 * behavior profile / permission mode / plan mode, resolves workspace resume
 * (with its two early-return shapes) and the effective cwd. Pure of Engine —
 * everything arrives via the args object (run-setup.ts / run-image-input.ts
 * style).
 */
import type { SessionKind } from "../types.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SettingsManager } from "../settings/manager.js";
import type { EngineConfig, EngineResult } from "./types.js";
import type { EngineRunOptions, RunBehaviorProfile } from "./run-types.js";
import { resolveRunProfileState, type RunProfileState } from "./run-setup.js";

/**
 * Resolve the working directory for a run. Precedence for legacy sessions:
 *   options.cwd  >  resumed session's state.cwd  >  config.cwd  >  process.cwd()
 * (Moved verbatim from engine.ts; engine.ts re-exports it for compatibility.)
 */
export function resolveRunCwd(args: {
  optionCwd?: string;
  sessionCwd?: string;
  configCwd?: string;
  processCwd: string;
}): string {
  return args.optionCwd ?? args.sessionCwd ?? args.configCwd ?? args.processCwd;
}

export interface RunWorkspaceResolution {
  sessionKind: SessionKind;
  sessionWorkspaceProfile: string | undefined;
  profile: RunBehaviorProfile | undefined;
  profileParams: Readonly<Record<string, unknown>>;
  runPermissionMode: NonNullable<EngineConfig["permissionMode"]>;
  runPlanMode: boolean;
  cwd: string;
  profileState: RunProfileState;
}

export type ResolveRunWorkspaceResult =
  | { ok: true; resolution: RunWorkspaceResolution }
  | { ok: false; result: EngineResult };

export async function resolveRunWorkspace(args: {
  options: EngineRunOptions | undefined;
  sessionManager: Pick<
    SessionManager,
    | "exists"
    | "readSessionKind"
    | "readSessionWorkspaceProfile"
    | "resolveSessionWorkspaceForResume"
    | "readSessionMainRoot"
  >;
  resolveBehaviorProfile: (
    sessionKind: string,
    behaviorMode: string | undefined,
  ) => RunBehaviorProfile | undefined;
  configPermissionMode: EngineConfig["permissionMode"];
  configCwd: string | undefined;
  settings: SettingsManager;
  processCwd: string;
}): Promise<ResolveRunWorkspaceResult> {
  const { options } = args;
  // ⬇ engine.ts L1263-1370 原样搬入,按下方替换表机械替换,
  //   两处 `return { text: ... }` 早退改为 `return { ok: false, result: { ... } }`,
  //   末尾改为:
  //   return { ok: true, resolution: { sessionKind, sessionWorkspaceProfile, profile,
  //     profileParams, runPermissionMode, runPlanMode, cwd, profileState } };
}
```

替换表(搬运时逐项应用):

| engine.ts 原文 | 模块内 |
|---|---|
| `this.sessionManager` | `args.sessionManager` |
| `this.resolveBehaviorProfile(sessionKind, options?.behaviorMode)` | `args.resolveBehaviorProfile(sessionKind, options?.behaviorMode)` |
| `this.config.permissionMode` | `args.configPermissionMode` |
| `this.config.cwd` | `args.configCwd` |
| `process.cwd()` | `args.processCwd` |
| `this.getSettingsManager()` | `args.settings` |
| `resolveRunProfileState({...})` 的三个返回名解构 | 收进 `const profileState = resolveRunProfileState({...})` |
| `let profileReportedResults ...`(L1303) | **不搬**,留在 engine |
| `let runPermissionMode = ...` 及 planMode 归一段 | 原样搬 |

锚点:起始行 `const persistedSessionKind =`(L1263);终止行 `} = resolveRunProfileState({`…`});`(L1362-1370)。

- [ ] **Step 4: engine.ts 侧替换**

删除 L1263-1370 与模块级 `resolveRunCwd` 函数(L226-243 附近,锚点 `export function resolveRunCwd(args: {`),在原 re-export 区(`export { resolveChildLlm, ... }` 附近)加:

```ts
export { resolveRunCwd } from "./run-workspace.js";
```

`runExclusive` 开头改为:

```ts
  private async runExclusive(task: string, options?: EngineRunOptions): Promise<EngineResult> {
    // Freeze permission context once, before the first await (see run-workspace.ts).
    const workspaceResolved = await resolveRunWorkspace({
      options,
      sessionManager: this.sessionManager,
      resolveBehaviorProfile: (kind, mode) => this.resolveBehaviorProfile(kind, mode),
      configPermissionMode: this.config.permissionMode,
      configCwd: this.config.cwd,
      settings: this.getSettingsManager(),
      processCwd: process.cwd(),
    });
    if (!workspaceResolved.ok) return workspaceResolved.result;
    const {
      sessionKind,
      sessionWorkspaceProfile,
      profile,
      profileParams,
      runPermissionMode,
      runPlanMode,
      cwd,
      profileState: { workspaceProfile: runWorkspaceProfile, sessionProfileOverrides, profileMemoryDir },
    } = workspaceResolved.resolution;
    /** Structured results the profile's run services report; keyed per profile contract. */
    let profileReportedResults: Record<string, unknown> | undefined;
```

并在顶部 import 区加 `import { resolveRunWorkspace } from "./run-workspace.js";`(`resolveRunCwd` 的 import 不再需要——原是本文件定义)。

- [ ] **Step 5: C1 验证 + 快照测试复跑**

```bash
bun test packages/core/src/engine/engine.session-kind.test.ts
bun test packages/core/src/engine/engine.resolve-cwd.test.ts
bun test packages/core/src/engine/engine.workspace-profile-session.test.ts
# 然后完整 C1 验证序列(见规约)
```

预期:全绿;`engine.resolve-cwd.test.ts` 不改一字(经 re-export 解析)。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/engine/run-workspace.ts packages/core/src/engine/engine.ts packages/core/src/engine/engine.session-kind.test.ts
git commit -m "refactor(core/engine): extract run-workspace resolution from runExclusive"
```

---

### Task 7: C1 模块 2 — run-session-open.ts(会话 create/resume + 用户消息追加)

**Files:**
- Create: `packages/core/src/engine/run-session-open.ts`
- Create: `packages/core/src/engine/engine.session-open.test.ts`
- Modify: `packages/core/src/engine/engine.ts:1532-1718`(HEAD 基准;Task 6 后行号前移 ~90 行,以锚点定位)

既有行为快照依据:`engine-client-message-id.test.ts`(submit/steer 幂等 + 早退)、`patch-orphaned-tools.test.ts`(孤儿 tool_use 修补单测)、`engine.todo-resume.test.ts`(resume 路径)、`engine.session-fork-history.test.ts`。**缺口**:cold-start summary 截断落盘无直接断言,先补。

- [ ] **Step 1: 写行为快照测试 `engine.session-open.test.ts`(完整内容)**

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";

const provider = "fake-session-open";

class SessionOpenClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return { text: "ok", toolCalls: [], stopReason: "stop", usage };
  }
}
registerProvider(provider, SessionOpenClient);

function makeEngine(dir: string): Engine {
  const engine = new Engine({
    llm: {
      provider,
      model: `${provider}-${Date.now()}-${Math.random()}`,
      apiKey: "test",
    } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    headless: true,
  });
  (engine as unknown as { hooks: { clear(): void } }).hooks.clear();
  return engine;
}

describe("runExclusive session open (run-session-open behavior snapshot)", () => {
  it("stamps the first 80 chars of the first user message as the session summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-session-open-"));
    try {
      const engine = makeEngine(dir);
      const task =
        "Summarize the repository layout for me please, including packages, scripts and docs directories in detail";
      const result = await engine.run(task, { sessionId: "s-open-summary", cwd: dir });
      expect(result.reason).toBe("completed");
      const state = JSON.parse(
        readFileSync(join(dir, "sessions", "s-open-summary", "state.json"), "utf8"),
      ) as { summary?: string; turnSeq?: number };
      expect(state.summary).toBe(task.slice(0, 80).replace(/\n/g, " "));
      expect(state.turnSeq).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("increments turnSeq on resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-session-open-"));
    try {
      const engine = makeEngine(dir);
      await engine.run("first", { sessionId: "s-open-seq", cwd: dir });
      await engine.run("second", { sessionId: "s-open-seq", cwd: dir });
      const state = JSON.parse(
        readFileSync(join(dir, "sessions", "s-open-seq", "state.json"), "utf8"),
      ) as { turnSeq?: number };
      expect(state.turnSeq).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

运行 `bun test packages/core/src/engine/engine.session-open.test.ts`,预期 2 pass(拆分前基线;若 `state.json` 字段名/路径与断言不符,以实际磁盘产物修正断言后再作基线——这属于把快照对准现状,不是改行为)。

- [ ] **Step 2: 创建 `run-session-open.ts`(骨架完整,函数体为 engine.ts L1547-1695 原样搬运)**

```ts
/**
 * Session open — create-or-resume phase of Engine.runExclusive: the three
 * valid session shapes, clientMessageId claiming (duplicate submits return
 * early), user-message append, cold-start summary and the turnSeq bump.
 */
import { getCurrentSid, logger } from "../logging/logger.js";
import type { Message, SessionKind } from "../types.js";
import type { SessionBundle, SessionManager } from "../session/session-manager.js";
import { patchOrphanedToolUses } from "./patch-orphaned-tools.js";
import type { ParsedTask } from "./parse-task.js";
import type { buildRunUserMessageContent } from "./run-image-input.js";
import type { EngineConfig, EngineResult } from "./types.js";
import type { EngineRunOptions } from "./run-types.js";

export interface OpenRunSessionArgs {
  sessionManager: SessionManager;
  options: EngineRunOptions | undefined;
  parsedTask: ParsedTask;
  taskText: string;
  userMessageContent: ReturnType<typeof buildRunUserMessageContent>;
  cwd: string;
  sessionKind: SessionKind;
  sessionWorkspaceProfile: string | undefined;
  llmModel: string;
  llmProvider: string;
  isSubAgent: boolean;
  origin: EngineConfig["origin"];
  costStore: EngineConfig["costStore"];
  onAgentDirectionsDelivered:
    | ((envelopeIds: NonNullable<EngineRunOptions["agentDirection"]>["envelopeIds"]) => void)
    | undefined;
}

export interface OpenedRunSession {
  session: SessionBundle;
  messages: Message[];
  freshImageMessage: Message | undefined;
  resumedFromDisk: boolean;
  claimClientMessageId: (
    bundle: SessionBundle,
    clientMessageId: string | undefined,
    source: "submit" | "steer",
  ) => boolean;
  releaseClientMessageId: (clientMessageId: string) => void;
}

export type OpenRunSessionResult =
  | { ok: true; opened: OpenedRunSession }
  | { ok: false; result: EngineResult };

export function openRunSession(args: OpenRunSessionArgs): OpenRunSessionResult {
  const { options } = args;
  const claimedClientMessageIds = new Set<string>();
  // ⬇ engine.ts L1552-1695 原样搬入(claimClientMessageId 闭包、resume 分支含
  //   compacted 缓存读取/patchOrphanedToolUses/costStore.restore/重复 submit 早退/
  //   transcript.appendMessage/status 落盘;cold-start 分支含 create/summary;
  //   收敛段含 workspaceProfile 戳 + turnSeq 自增),按替换表机械替换。
  //   重复 submit 早退改 `return { ok: false, result: { ... } }`;
  //   末尾:
  //   return { ok: true, opened: { session, messages, freshImageMessage,
  //     resumedFromDisk, claimClientMessageId,
  //     releaseClientMessageId: (id) => { claimedClientMessageIds.delete(id); } } };
}
```

替换表:

| engine.ts 原文 | 模块内 |
|---|---|
| `this.sessionManager` | `args.sessionManager` |
| `this.compactedMessagesBySession.get(options.sessionId)` | **不搬**——见 Step 3(compacted 缓存经参数传值) |
| `this.config.costStore` | `args.costStore` |
| `this.config.llm.model` / `.provider` | `args.llmModel` / `args.llmProvider` |
| `this.config.isSubAgent === true` | `args.isSubAgent` |
| `this.config.origin` | `args.origin` |
| `this.agentDirectionsDeliveredListener?.(...)` | `args.onAgentDirectionsDelivered?.(...)` |
| `getCurrentSid()` | 保留(模块自 import) |

compacted 缓存处理:`OpenRunSessionArgs` 增加一项 `cachedCompactedMessages: Message[] | undefined`,engine 调用时传 `options?.sessionId ? this.compactedMessagesBySession.get(options.sessionId) : undefined`,模块内 L1576-1577 改为 `const cachedCompacted = args.cachedCompactedMessages;`。

- [ ] **Step 3: engine.ts 侧替换**

`let session: SessionBundle;` 声明保留(改为 `let session!: SessionBundle;`,`wrappedOnStream` 闭包在会话打开前定义、打开后才会执行,维持现状语义),原 L1547-1695 整段替换为:

```ts
    const openedResult = openRunSession({
      sessionManager: this.sessionManager,
      options,
      parsedTask,
      taskText,
      userMessageContent,
      cwd,
      sessionKind,
      sessionWorkspaceProfile,
      llmModel: this.config.llm.model,
      llmProvider: this.config.llm.provider,
      isSubAgent: this.config.isSubAgent === true,
      origin: this.config.origin,
      costStore: this.config.costStore,
      onAgentDirectionsDelivered: (ids) => this.agentDirectionsDeliveredListener?.(ids),
      cachedCompactedMessages: options?.sessionId
        ? this.compactedMessagesBySession.get(options.sessionId)
        : undefined,
    });
    if (!openedResult.ok) return openedResult.result;
    const { messages, freshImageMessage, resumedFromDisk, claimClientMessageId, releaseClientMessageId } =
      openedResult.opened;
    session = openedResult.opened.session;
```

TurnLoop 构造参数里 `releaseClientMessageId: (clientMessageId) => { claimedClientMessageIds.delete(clientMessageId); }`(原 L2589-2591)改为 `releaseClientMessageId,`;`claimClientMessageId: (clientMessageId, source) => claimClientMessageId(session, clientMessageId, source)` 保持不变。toolCtx 会话戳段(原 L1705-1719)与 turn 计数注释保留在 engine。顶部加 `import { openRunSession } from "./run-session-open.js";`。

- [ ] **Step 4: C1 验证 + 重点复跑**

```bash
bun test packages/core/src/engine/engine-client-message-id.test.ts
bun test packages/core/src/engine/engine.session-open.test.ts
# 完整 C1 验证序列
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/run-session-open.ts packages/core/src/engine/engine.ts packages/core/src/engine/engine.session-open.test.ts
git commit -m "refactor(core/engine): extract run-session-open from runExclusive"
```

---

### Task 8: C1 模块 3 — run-tooling.ts(ToolContext / 权限管线 / MCP / tool defs)

**Files:**
- Create: `packages/core/src/engine/run-tooling.ts`
- Modify: `packages/core/src/engine/engine.ts:1485-1522, 1876-1933, 1986-2003, 2023-2145`(HEAD 基准,锚点定位)

既有行为快照依据(充分,不新增测试):`engine.permission-rules.test.ts`、`engine.permission-boundary.test.ts`、`dynamic-tool-defs.test.ts`、`engine.quick-chat-restricted.test.ts`、`engine.no-repo-whitelist.test.ts`、`engine.shell-env.test.ts`、`runtime.sandbox-cache.test.ts`、`subagent-spawner.test.ts`、`tool-system` 全家(经 `bun test packages/core`)。

**红线:`createSubAgentSpawner({ ... childRunner: { createChild: (config) => new Engine(config), ... } })`(L1435-1455)整段留在 engine.ts** —— `new Engine(` 只允许出现在白名单文件。sandbox 解析(L1430、L1467-1479)同样留下(已由 `RunEnvironmentResolver` 承载)。

- [ ] **Step 1: 列快照依据并跑基线**

```bash
bun test packages/core/src/engine/engine.permission-rules.test.ts packages/core/src/engine/engine.permission-boundary.test.ts packages/core/src/engine/dynamic-tool-defs.test.ts packages/core/src/engine/engine.quick-chat-restricted.test.ts
```

预期:全绿。

- [ ] **Step 2: 创建 `run-tooling.ts`,四个函数(签名完整;函数体按行段原样搬运)**

```ts
/**
 * Run tooling — per-run tool surface assembly for Engine.runExclusive:
 * ToolContext construction, the permission classifier + executor pipeline,
 * MCP connection, and the per-turn tool-definition visibility pass.
 * The sub-agent spawner and sandbox resolution stay in engine.ts (the
 * `new Engine(` allowlist and RunEnvironmentResolver own them).
 */
import type { MCPServerConfig, TaskInfo, ToolDefinition } from "../types.js";
import type { ToolContext } from "../tool-system/context.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { InvestigationGuard } from "../tool-system/investigation-guard.js";
import { TaskGuard } from "../tool-system/task-guard.js";
import {
  PermissionClassifier,
  InteractiveApprovalBackend,
} from "../tool-system/permission.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import {
  buildMcpToolPolicies,
  isRegisteredMcpToolAllowed,
} from "../tool-system/mcp-tool-policy.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { HookRegistry } from "../hooks/registry.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "../tool-system/plan-mode-allowlist.js";
import {
  isFeatureEnabled,
  type FeatureFlagName,
} from "../settings/feature-flags.js";
import type { CapabilityOverride } from "../settings/schema.js";
import { applyDynamicToolDef } from "./dynamic-tool-defs.js";
import type { PermissionController } from "./permission-controller.js";
import type { EngineRunOptions, RunBehaviorProfile } from "./run-types.js";

/** engine.ts L1485-1522 —— ToolContext 组装(spawner、agentDefinitions、base 由调用方传入)。 */
export function buildRunToolContext(args: {
  base: ToolContext; // this.buildToolContext(cwd, sessionProfileOverrides, profileMemoryDir)
  options: EngineRunOptions | undefined;
  configApprovalRouter: ToolContext["approvalRouter"];
  runPermissionMode: ToolContext["permissionMode"];
  runPlanMode: boolean;
  subAgentSpawner: ToolContext["subAgentSpawner"];
  agentDefinitions: ToolContext["agentDefinitions"];
  sandbox: ToolContext["sandbox"]; // engine 已完成 network 贴附的 backend(或 off)
  cwd: string;
  shellEnv: ToolContext["shellEnv"];
  profile: RunBehaviorProfile | undefined;
  profileParams: Readonly<Record<string, unknown>>;
  reportResult: (key: string, value: unknown) => void;
}): ToolContext {
  // 原样搬运;`(profileReportedResults ??= {})[key] = value` 改为 args.reportResult(key, value)。
}

/** engine.ts L1876-1933 —— 权限分类器 + 审批监听 + ToolExecutor + guards。 */
export function buildRunPermissionPipeline(args: {
  permissionController: PermissionController;
  mode: ToolContext["permissionMode"];
  cwd: string;
  approvalRouter: ToolContext["approvalRouter"];
  sessionId: string;
  toolRegistry: ToolRegistry;
  hooks: HookRegistry;
  toolCtx: ToolContext;
  signal: AbortSignal | undefined;
  readOnlySession: boolean;
  headless: boolean;
  getLatestTodos: () => TaskInfo[];
  onApprovalPhase: (waiting: boolean, toolName: string | undefined) => void;
  emitNotificationHook: (payload: Record<string, unknown>) => void;
}): { permission: PermissionClassifier; toolExecutor: ToolExecutor } {
  // 原样搬运;`options?.onAgentProgress?.({type:"phase",...})` 改经 args.onApprovalPhase;
  // `void this.emitHook("notification", {...})` 改 args.emitNotificationHook({...})。
}

/** engine.ts L1986-2003 —— MCP 连接(Runtime 池优先,回退 per-Engine)。 */
export async function connectRunMcp(args: {
  mcpServers: Record<string, MCPServerConfig>;
  mcpDisabled: boolean;
  getManager: () => MCPManager | undefined;
  setManager: (manager: MCPManager) => void;
  runtimePool: MCPManager | undefined;
  toolRegistry: ToolRegistry;
  engineForConnect: Parameters<MCPManager["connectAll"]>[1];
  emitNotificationHook: (payload: Record<string, unknown>) => void;
}): Promise<void> {
  // 原样搬运;`this.mcpManager` 读写改 get/setManager;`this.runtime.mcpPool` 改 runtimePool;
  // `await this.mcpManager.connectAll(mcpServers, this, cb)` 改
  // `await manager.connectAll(args.mcpServers, args.engineForConnect, cb)`。
}

/** engine.ts L2023-2145 —— builtin override / MCP 可见性 / feature flags / 动态 defs / plan-mode 过滤。
 *  注意:本函数按原逻辑就地 mutate toolCtx(toolVisibility/disabledBuiltins/
 *  allowedMcpServers/mcpToolPolicies)。 */
export function assembleRunToolDefs(args: {
  toolRegistry: ToolRegistry;
  toolCtx: ToolContext;
  guardCwd: string;
  hasRunnableGoal: boolean;
  settingsScope: "user" | "project";
  builtinToolHost: unknown; // EngineConfig["builtinToolHost"] —— 按 engine/types.ts 实际类型标注
  isSubAgent: boolean;
  behaviorProfileId: string | undefined;
  profileMeta: unknown | undefined; // profile?.buildVisibilityMeta?.(profileParams)
  builtinOverride: Record<string, CapabilityOverride> | undefined;
  mcpServers: Record<string, MCPServerConfig>;
  mcpDisabled: boolean;
  featureFlags: Parameters<typeof isFeatureEnabled>[0];
  toolGuards: ReadonlyMap<string, (visibility: unknown) => boolean>;
  toolRewriters: ReadonlyMap<
    string,
    (tool: ToolDefinition, visibility: unknown) => ToolDefinition
  >;
  toolFeatureFlags: ReadonlyMap<string, FeatureFlagName>;
  applyBuiltinOverrideVisibility: <T extends { name: string }>(
    tools: T[],
    override: Record<string, CapabilityOverride> | undefined,
  ) => T[];
  profileAllowedToolNames: ReadonlySet<string> | undefined;
  runPlanMode: boolean;
}): ToolDefinition[] {
  // 原样搬运;`this.toolRegistry`→args.toolRegistry、`this.toolGuards`→args.toolGuards、
  // `this.toolRewriters`→args.toolRewriters、`TOOL_FEATURE_FLAGS`→args.toolFeatureFlags、
  // `applyBuiltinOverrideVisibility(...)`→args.applyBuiltinOverrideVisibility(...)、
  // `this.config.mcpServers ?? {}`→args.mcpServers、profileMeta/toolVisibility 组装按参数。
  // 返回过滤后的 toolDefs(原 `const toolDefs = runPlanMode ? ... : profileToolDefs`)。
}
```

注:`applyBuiltinOverrideVisibility` 与 `TOOL_FEATURE_FLAGS` 定义仍在 engine.ts(前者是被测导出、后者是模块常量),经参数传入,避免模块回 import engine(boundary 红线)。若 lint 提示 `builtinToolHost`/`profileMeta` 的 `unknown` 可精化,以 `EngineConfig["builtinToolHost"]` 与 `RunBehaviorProfile["buildVisibilityMeta"]` 推导类型替换。

- [ ] **Step 3: engine.ts 侧替换(四处调用)**

```ts
    // (1) ToolContext —— 原 L1485-1522 替换为:
    const toolCtx: ToolContext = buildRunToolContext({
      base: this.buildToolContext(cwd, sessionProfileOverrides, profileMemoryDir),
      options,
      configApprovalRouter: this.config.approvalRouter,
      runPermissionMode,
      runPlanMode,
      subAgentSpawner,
      agentDefinitions: this.getAgentDefinitions(cwd, sessionProfileOverrides),
      sandbox:
        sandboxBackend.name === "off"
          ? sandboxBackend
          : { ...sandboxBackend, network: sandboxConfig.network },
      cwd,
      shellEnv: this.runEnvironmentResolver.readShellEnv(cwd),
      profile,
      profileParams,
      reportResult: (key, value) => {
        (profileReportedResults ??= {})[key] = value;
      },
    });

    // (2) 权限管线 —— 原 L1876-1933 替换为:
    const { permission, toolExecutor } = buildRunPermissionPipeline({
      permissionController: this.permissionController,
      mode,
      cwd,
      approvalRouter: toolCtx.approvalRouter,
      sessionId: session.state.sessionId,
      toolRegistry: this.toolRegistry,
      hooks: this.hooks,
      toolCtx,
      signal: options?.signal,
      readOnlySession: this.config.readOnlySession === true,
      headless: this.config.headless === true,
      getLatestTodos: () => latestTodos,
      onApprovalPhase: (waiting, toolName) => {
        options?.onAgentProgress?.({
          type: "phase",
          phase: waiting ? "waiting-permission" : "tool",
          toolName,
        });
      },
      emitNotificationHook: (payload) => {
        void this.emitHook("notification", payload);
      },
    });

    // (3) MCP —— 原 L1986-2003 替换为:
    await connectRunMcp({
      mcpServers: this.config.mcpServers ?? {},
      mcpDisabled,
      getManager: () => this.mcpManager,
      setManager: (m) => {
        this.mcpManager = m;
      },
      runtimePool: this.runtime?.mcpPool,
      toolRegistry: this.toolRegistry,
      engineForConnect: this,
      emitNotificationHook: (payload) => {
        void this.emitHook("notification", payload);
      },
    });

    // (4) tool defs —— 原 L2023-2145 替换为:
    const toolDefs = assembleRunToolDefs({
      toolRegistry: this.toolRegistry,
      toolCtx,
      guardCwd: toolCtx.cwd,
      hasRunnableGoal,
      settingsScope: this.config.settingsScope ?? "project",
      builtinToolHost: this.config.builtinToolHost,
      isSubAgent: this.config.isSubAgent === true,
      behaviorProfileId: profile?.id ?? options?.behaviorMode,
      profileMeta: profile?.buildVisibilityMeta?.(profileParams),
      builtinOverride: this.readBuiltinOverride(toolCtx.cwd, sessionProfileOverrides),
      mcpServers: this.config.mcpServers ?? {},
      mcpDisabled,
      featureFlags: this.readFeatureFlags(),
      toolGuards: this.toolGuards,
      toolRewriters: this.toolRewriters,
      toolFeatureFlags: TOOL_FEATURE_FLAGS,
      applyBuiltinOverrideVisibility,
      profileAllowedToolNames: profile?.allowedToolNames,
      runPlanMode,
    });
```

被搬走行段删除;`InteractiveApprovalBackend`、`InvestigationGuard`、`TaskGuard`、`buildMcpToolPolicies`、`isRegisteredMcpToolAllowed`、`applyDynamicToolDef`、`PLAN_MODE_ALLOWED_TOOLS`、`isFeatureEnabled` 等仅剩模块使用的 import 从 engine.ts 移除(lint 校对)。permission 变量在 approvalBackend 段(interactive project-rules 回调)内部引用——该段随 L1876-1933 一起在模块内,`permission.reconfigure(...)` 不跨界。

- [ ] **Step 4: C1 验证**(规约命令全跑)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/run-tooling.ts packages/core/src/engine/engine.ts
git commit -m "refactor(core/engine): extract run-tooling (tool context, permission pipeline, MCP, tool defs)"
```

---

### Task 9: C1 模块 4 — run-context.ts(ContextManager 播种 + 消息组装)

**Files:**
- Create: `packages/core/src/engine/run-context.ts`
- Modify: `packages/core/src/engine/engine.ts:1792-1841, 2156-2193`(HEAD 基准,锚点定位)

既有行为快照依据(充分,不新增测试):`engine.context-anchor.test.ts`(anchor 兼容性播种)、`injected-context-cache.test.ts`(userContext/volatile 注入与剥离)、`engine.prompt-cache.test.ts` + `cache-hit-rate.test.ts`(seed 一次性/缓存前缀)、`engine.context-package.test.ts`、`engine.prompt-too-long.test.ts`。

- [ ] **Step 1: 跑基线**

```bash
bun test packages/core/src/engine/engine.context-anchor.test.ts packages/core/src/engine/injected-context-cache.test.ts packages/core/src/engine/engine.prompt-cache.test.ts
```

- [ ] **Step 2: 创建 `run-context.ts`(三个函数,体为原样搬运)**

```ts
/**
 * Run context — ContextManager creation/seeding and the per-run message-list
 * assembly (user context, lifecycle reminders, volatile dynamic context, and
 * the runtime-context system-prompt tail).
 */
import { ContextManager } from "../context/manager.js";
import { wrapHookMessages } from "../hooks/inject.js";
import type { Message, SessionState } from "../types.js";
import type { RunBehaviorProfile } from "./run-types.js";

export interface RunContextSeed {
  tokens: number;
  source: "heuristic_estimate" | (string & {});
  confidence: "low" | (string & {});
}

/** engine.ts L1792-1841:ContextManager + anchor 兼容播种 + 首帧 ctx seed。 */
export function createRunContextManager(args: {
  maxTokens: number;
  ratios: Record<string, number | undefined>; // this.resolveContextRatios() 的返回
  persistedAnchor: SessionState["contextUsageAnchor"];
  llmProvider: string;
  llmModel: string;
  messages: Message[];
  needsCtxSeed: boolean;
}): { contextManager: ContextManager; ctxSeed: RunContextSeed } {
  // 原样搬运:new ContextManager({maxTokens, ...ratiosFiltered})、
  // contextAnchorCompatible 判定 + seedActualUsage、needsCtxSeed 分支的 checkLimits。
  // `this.resolveMaxContextTokens()`→args.maxTokens;
  // `this.resolveContextRatios()`→args.ratios;
  // `this.config.llm.provider/.model`→args.llmProvider/args.llmModel。
}

/** engine.ts L2156-2164:runtimeContext 尾巴拼接(纯函数)。 */
export function composeRunSystemPrompt(args: {
  baseSystemPrompt: string;
  profile: RunBehaviorProfile | undefined;
  profileParams: Readonly<Record<string, unknown>>;
}): string {
  // 原样搬运 runtimeContextTag/runtimeContextValue/fullSystemPrompt 三段。
}

/** engine.ts L2166-2193:userContext unshift + lifecycle reminder splice + volatile push。
 *  就地 mutate messages(与原逻辑一致)。 */
export function assembleRunMessages(args: {
  messages: Message[];
  userContextMsg: Message | undefined;
  hookMessages: Message[]; // [...(sessionStartHook.messages ?? []), ...(promptSubmitHook.messages ?? [])]
  dynamicContextMsg: Message | undefined;
}): void {
  // 原样搬运;wrapHookMessages(args.hookMessages) 得 lifecycleReminder。
}
```

- [ ] **Step 3: engine.ts 侧替换**

```ts
    const { contextManager, ctxSeed } = createRunContextManager({
      maxTokens: this.resolveMaxContextTokens(),
      ratios: this.resolveContextRatios(),
      persistedAnchor: session.state.contextUsageAnchor,
      llmProvider: this.config.llm.provider,
      llmModel: this.config.llm.model,
      messages,
      needsCtxSeed: !this.ctxSeedSent.has(session.state.sessionId),
    });
    this.lastContextManager = contextManager;
    const sid = session.state.sessionId;
    if (!this.ctxSeedSent.has(sid)) this.ctxSeedSent.add(sid);
```

(`session_started` 事件发射与 todo 快照回放两小段留在 engine,消费 `ctxSeed`,原文不动。)

系统提示尾巴与消息组装处:

```ts
    const fullSystemPrompt = composeRunSystemPrompt({ baseSystemPrompt, profile, profileParams });
    const userContextMsg = promptComposer.buildUserContextMessage();
    assembleRunMessages({
      messages,
      userContextMsg,
      hookMessages: [...(sessionStartHook.messages ?? []), ...(promptSubmitHook.messages ?? [])],
      dynamicContextMsg,
    });
```

删除被搬运行段;顶部 import 三个新函数;`wrapHookMessages`、`ContextManager` 的 import 若仅剩模块使用则移除(`ContextManager` 在 forceCompact 等处仍用,保留——以 lint 为准)。

- [ ] **Step 4: C1 验证**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/run-context.ts packages/core/src/engine/engine.ts
git commit -m "refactor(core/engine): extract run-context (context manager seeding, message assembly)"
```

---

### Task 10: C1 模块 5 — run-accounting.ts(usage 记账 + ModelFacade 装配)

**Files:**
- Create: `packages/core/src/engine/run-accounting.ts`
- Modify: `packages/core/src/engine/engine.ts:2226-2341`(HEAD 基准,锚点 `let externalRunUsage: TokenUsage = {` 起、`modelFacade.summarize = ...` 段止)

既有行为快照依据(充分,不新增测试):`cache-hit-rate.test.ts`、`turn-loop-usage-cache.test.ts`、`engine.auto-compaction-goal.test.ts`(预算护栏:billed sub-call 耗尽预算后主调用短路)、`model-facade-recorder-redaction.test.ts`、`engine.session-title.test.ts`(finalize 之后的 late-usage 持久化路径)。

- [ ] **Step 1: 跑基线**

```bash
bun test packages/core/src/engine/engine.auto-compaction-goal.test.ts packages/core/src/engine/cache-hit-rate.test.ts packages/core/src/engine/turn-loop-usage-cache.test.ts
```

- [ ] **Step 2: 创建 `run-accounting.ts`(签名完整,体为原样搬运)**

```ts
/**
 * Run accounting — cumulative usage counters, the external-billed-usage
 * funnel (aux summaries, goal judge, title), the goal-budget guard on the
 * primary model call, and the ModelFacade wiring for a run.
 */
import type { TokenUsage } from "../types.js";
import {
  addTokenUsage,
  addCumulativeUsage,
  normalizeCumulativeUsageCounters,
  type CumulativeUsageCounters,
} from "../session/usage.js";
import { logger } from "../logging/logger.js";
import type { LLMClientBase } from "../llm/client-base.js";
import type { Transcript } from "../session/transcript.js";
import type { SessionBundle, SessionStateFieldPatch } from "../session/session-manager.js";
import { ModelFacade } from "./model-facade.js";
import type { TurnLoop } from "./turn-loop.js";
import type { EngineConfig } from "./types.js";

export interface RunUsageAccounting {
  recordCumulativeUsage: (usage: TokenUsage) => CumulativeUsageCounters;
  recordExternalBilledUsage: (usage: TokenUsage) => CumulativeUsageCounters;
  getExternalRunUsage: () => TokenUsage;
  /** goal 预算耗尽后主模型调用需要短路(见 wireRunModelFacade)。 */
  hasGoalBudgetTermination: () => boolean;
  markRunAccountingFinalized: () => void;
}

/** engine.ts L2226-2269:externalRunUsage/runAccountingFinalized/两个 record 闭包。 */
export function createRunUsageAccounting(args: {
  session: SessionBundle;
  sid: string;
  resumeState: (sid: string) => SessionBundle["state"]; // this.sessionManager.resume(sid).state
  updatePersistedSessionState: (sid: string, patch: SessionStateFieldPatch) => void;
  costStore: EngineConfig["costStore"];
  /** engine 侧闭包 (usage) => turnLoop.recordGoalJudgeUsage(usage)(turnLoop 延迟赋值)。 */
  recordGoalJudgeUsage: (
    usage: TokenUsage,
  ) => ReturnType<TurnLoop["recordGoalJudgeUsage"]>;
}): RunUsageAccounting {
  // 原样搬运。normalizeCumulativeUsageCounters 的 Object.assign 预处理(L2234-2237)
  // 一并搬入本函数开头;autoCompactionGoalTermination 成为模块内闭包变量,
  // hasGoalBudgetTermination() 暴露读取。
}

/** engine.ts L2272-2341:ModelFacade + 预算护栏 call 包装 + getRunUsage + aux summarize。 */
export function wireRunModelFacade(args: {
  llmClient: LLMClientBase;
  auxSummaryClient: LLMClientBase;
  transcript: Transcript;
  accounting: RunUsageAccounting;
}): {
  modelFacade: ModelFacade;
  getRunUsage: () => ReturnType<ModelFacade["getUsage"]>;
} {
  // 原样搬运:new ModelFacade、getRunUsage(叠加 externalRunUsage)、
  // callPrimaryModel 包装(accounting.hasGoalBudgetTermination() 短路)、
  // getOutputTokens、modelFacade.summarize(aux client + recordExternalBilledUsage)。
}
```

- [ ] **Step 3: engine.ts 侧替换**

原 L2226-2341 替换为:

```ts
    // eslint-disable-next-line prefer-const
    let turnLoop!: TurnLoop;
    const accounting = createRunUsageAccounting({
      session,
      sid,
      resumeState: (s) => this.sessionManager.resume(s).state,
      updatePersistedSessionState: (s, patch) => this.updatePersistedSessionState(s, patch),
      costStore: this.config.costStore,
      recordGoalJudgeUsage: (usage) => turnLoop.recordGoalJudgeUsage(usage),
    });
    const { recordCumulativeUsage, recordExternalBilledUsage } = accounting;
    contextManager.setSummarizeFn(this.buildSummarizeFn(llmClient, recordExternalBilledUsage));
    const { modelFacade, getRunUsage } = wireRunModelFacade({
      llmClient,
      auxSummaryClient,
      transcript: session.transcript,
      accounting,
    });
    const usageBaseline: TokenUsage = { ...session.state.tokenUsage };
```

后续引用改名:`externalRunUsage` 不再直接可见(finalize 用 `getRunUsage()`,已覆盖);`runAccountingFinalized = true;`(原 L2969)改为 `accounting.markRunAccountingFinalized();`。goal 段(Task 11 前暂在原地)的 `recordCumulativeUsage(usage)` / `turnLoop.recordGoalJudgeUsage(usage)` 引用保持可用(解构 + engine 闭包)。

- [ ] **Step 4: C1 验证**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/run-accounting.ts packages/core/src/engine/engine.ts
git commit -m "refactor(core/engine): extract run-accounting (usage funnel, model facade wiring)"
```

---

### Task 11: C1 模块 6 — run-goal.ts(goal 归一化/arm/终态)

**Files:**
- Create: `packages/core/src/engine/run-goal.ts`
- Modify: `packages/core/src/engine/engine.ts:2392-2514, 2711-2757`(HEAD 基准,锚点 `const explicitGoal = normalizeGoal(options?.goal);` 与 `const applyGoalTermination = (`)

既有行为快照依据(充分,不新增测试):`turn-loop-goal-lifecycle.test.ts`、`engine.auto-compaction-goal.test.ts`、`goal-judge-context.test.ts`、`hooks/goal-stop-hook.test.ts`、`turn-loop-continuation.test.ts`、`turn-loop-max-turns.test.ts`。

Engine 的四个运行时槽位(`activeRuntimeGoal`/`activePersistedRunGoal`/`activeGoalHook`/`activeGoalHookAttached`)经 `GoalRunSlots` 接口传入,engine 保有字段所有权(mid-run edit/pause/resume/clear 的既有公共方法不动)。

- [ ] **Step 1: 跑基线**

```bash
bun test packages/core/src/engine/turn-loop-goal-lifecycle.test.ts packages/core/src/engine/engine.auto-compaction-goal.test.ts packages/core/src/engine/goal-judge-context.test.ts packages/core/src/hooks/goal-stop-hook.test.ts
```

- [ ] **Step 2: 创建 `run-goal.ts`(签名完整,体为原样搬运)**

```ts
/**
 * Run goal — persistent-goal resolution (explicit > stored > config default),
 * arming the GoalStopHook for the run, and the terminal-outcome applier.
 * Engine keeps ownership of its active-goal slots via GoalRunSlots.
 */
import { randomUUID } from "node:crypto";
import type { StreamCallback } from "../types.js";
import {
  normalizeGoal,
  resolveGoalSetAt,
  goalConfigFromLifecycle,
  isGoalLifecycleCurrent,
  isSameGoalVersion,
  type GoalConfig,
  type GoalTerminationReason,
} from "../goal/lifecycle.js";
import { createGoalStopHook, type GoalJudgeRuntimeContext } from "../hooks/goal-stop-hook.js";
import type { HookRegistry } from "../hooks/registry.js";
import type { LLMClientBase } from "../llm/client-base.js";
import { logger } from "../logging/logger.js";
import type { SessionBundle, SessionManager } from "../session/session-manager.js";
import type { TokenUsage } from "../types.js";
import type { TurnLoop } from "./turn-loop.js";
import type { EngineConfig } from "./types.js";
import type { EngineRunOptions } from "./run-types.js";

export type GoalStopHookHandler = ReturnType<typeof createGoalStopHook>;

export interface GoalRunSlots {
  getActiveRuntimeGoal(): GoalConfig | null;
  setActiveRuntimeGoal(goal: GoalConfig | null): void;
  getActivePersistedRunGoal(): GoalConfig | null;
  setActivePersistedRunGoal(goal: GoalConfig | null): void;
  getActiveGoalHook(): GoalStopHookHandler | null;
  setActiveGoalHook(hook: GoalStopHookHandler | null): void;
  setActiveGoalHookAttached(attached: boolean): void;
}

/** engine.ts L2392-2453:explicit/stored/fallback 归一化 + 持久化 + goal_set 事件。 */
export function resolveRunGoal(args: {
  options: EngineRunOptions | undefined;
  session: SessionBundle;
  sessionManager: Pick<SessionManager, "saveActiveGoal">;
  configGoal: EngineConfig["goal"];
  isSubAgent: boolean;
  sid: string;
  onStream: StreamCallback | undefined;
}): { normalizedGoal: GoalConfig | undefined; persistedRunGoal: GoalConfig | undefined } {
  // 原样搬运。
}

/** engine.ts L2454-2514:GoalStopHook 创建 + 注册 + 槽位登记。 */
export function armRunGoalHook(args: {
  slots: GoalRunSlots;
  hooks: HookRegistry;
  llmClient: LLMClientBase;
  isSubAgent: boolean;
  normalizedGoal: GoalConfig | undefined;
  persistedRunGoal: GoalConfig | undefined;
  session: SessionBundle;
  sessionManager: Pick<SessionManager, "markGoalWaiting" | "readActiveGoal">;
  persistGoalTerminal: (
    state: SessionBundle["state"],
    goal: GoalConfig,
    reason: "completed" | GoalTerminationReason,
  ) => boolean;
  getJudgeContext: () => GoalJudgeRuntimeContext | undefined;
  recordCumulativeUsage: (usage: TokenUsage) => unknown;
  recordGoalJudgeUsage: (usage: TokenUsage | undefined) => ReturnType<TurnLoop["recordGoalJudgeUsage"]>;
}): GoalStopHookHandler | null {
  // 原样搬运;`this.activeRuntimeGoal = ...` 等改 slots.set*;
  // `this.hooks.register("on_stop", ...)` → args.hooks.register(...)。
}

/** engine.ts L2711-2757:goal 终态落盘 + 事件 + 钩子摘除(闭包工厂)。 */
export function createGoalTerminationApplier(args: {
  slots: GoalRunSlots;
  hooks: HookRegistry;
  session: SessionBundle;
  persistedRunGoal: GoalConfig | undefined;
  goalHookHandler: GoalStopHookHandler | null;
  persistGoalTerminalOutcome: (
    state: SessionBundle["state"],
    goal: GoalConfig,
    termination: GoalTerminationReason,
  ) => "persisted" | "failed" | (string & {});
  readActiveGoal: (sid: string) => GoalConfig | undefined | null;
  onStream: StreamCallback | undefined;
}): (termination: GoalTerminationReason | undefined, round: number | undefined) => void {
  // 原样搬运 applyGoalTermination 函数体。
}
```

- [ ] **Step 3: engine.ts 侧替换**

```ts
    const goalSlots: GoalRunSlots = {
      getActiveRuntimeGoal: () => this.activeRuntimeGoal,
      setActiveRuntimeGoal: (g) => {
        this.activeRuntimeGoal = g;
      },
      getActivePersistedRunGoal: () => this.activePersistedRunGoal,
      setActivePersistedRunGoal: (g) => {
        this.activePersistedRunGoal = g;
      },
      getActiveGoalHook: () => this.activeGoalHook,
      setActiveGoalHook: (h) => {
        this.activeGoalHook = h;
      },
      setActiveGoalHookAttached: (a) => {
        this.activeGoalHookAttached = a;
      },
    };
    const { normalizedGoal, persistedRunGoal } = resolveRunGoal({
      options,
      session,
      sessionManager: this.sessionManager,
      configGoal: this.config.goal,
      isSubAgent: this.config.isSubAgent === true,
      sid,
      onStream: options?.onStream,
    });
    let latestGoalJudgeContext: GoalJudgeRuntimeContext | undefined;
    const goalHookHandler = armRunGoalHook({
      slots: goalSlots,
      hooks: this.hooks,
      llmClient,
      isSubAgent: this.config.isSubAgent === true,
      normalizedGoal,
      persistedRunGoal,
      session,
      sessionManager: this.sessionManager,
      persistGoalTerminal: (state, goal, reason) => this.persistGoalTerminal(state, goal, reason),
      getJudgeContext: () => latestGoalJudgeContext,
      recordCumulativeUsage,
      recordGoalJudgeUsage: (usage) => turnLoop.recordGoalJudgeUsage(usage),
    });
    // …TurnLoop 构造(不动)…
    const applyGoalTermination = createGoalTerminationApplier({
      slots: goalSlots,
      hooks: this.hooks,
      session,
      persistedRunGoal,
      goalHookHandler,
      persistGoalTerminalOutcome: (state, goal, t) =>
        this.persistGoalTerminalOutcome(state, goal, t),
      readActiveGoal: (s) => this.sessionManager.readActiveGoal(s),
      onStream: options?.onStream,
    });
```

TurnLoop 构造参数里 `clearPersistedGoal` 回调(原 L2611-2626)保留在 engine(引用 goalSlots 与 `this.persistGoalTerminal`,原文语义不变,`this.activeGoalHook` 等读写改经 goalSlots 亦可,保持一处风格);`finally` 里的钩子摘除段(L2834-2840)原文保留(读 `goalHookHandler`/goalSlots)。删除被搬运行段与 goal 相关只剩模块使用的 import(`normalizeGoal`、`resolveGoalSetAt`、`createGoalStopHook` 等——`normalizeGoal` 在 visibility 预判段 L1935-1946 仍用,保留,以 lint 为准)。

- [ ] **Step 4: C1 验证**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/run-goal.ts packages/core/src/engine/engine.ts
git commit -m "refactor(core/engine): extract run-goal (goal resolution, stop-hook arming, termination)"
```

---

### Task 12: C1 模块 7 — run-finalize.ts(headless 排水 + 收尾 + 失败终态)

**Files:**
- Create: `packages/core/src/engine/run-finalize.ts`
- Modify: `packages/core/src/engine/engine.ts:2781-2830, 2847-3009, 3011-3044`(HEAD 基准,锚点 `if (isTopLevel && this.isHeadless()) {`、`this.lastMessages = result.messages;`、`return Promise.resolve(sessionRun).catch(`)

既有行为快照依据(充分,不新增测试):`runtime/background-shell.engine-regression.test.ts`、`tool-system/builtin/agent.auto-background.test.ts`、`tool-system/builtin/agent-registry.test.ts`(headless 排水);`engine.session-title.test.ts`(title 生成+落盘);`engine.init-lifecycle.test.ts`(初始化失败 → model_error 终态);`friendly-error.test.ts`;`engine.max-turns-stream.test.ts`、`engine.concurrent-run.test.ts`(终态/状态持久化)。

- [ ] **Step 1: 跑基线**

```bash
bun test packages/core/src/runtime/background-shell.engine-regression.test.ts packages/core/src/engine/engine.session-title.test.ts packages/core/src/engine/engine.init-lifecycle.test.ts packages/core/src/engine/friendly-error.test.ts
```

- [ ] **Step 2: 创建 `run-finalize.ts`(签名完整,体为原样搬运)**

```ts
/**
 * Run finalize — the headless background-agent drain loop, the success-path
 * epilogue (persistence, hooks, memory pipeline trigger, session title,
 * result assembly) and the initialization-failure terminal result.
 */
import { asyncAgentRegistry } from "../tool-system/builtin/agent-registry.js";
import {
  notificationQueue,
  buildNotificationMessage,
} from "../tool-system/builtin/agent-notifications.js";
import { logger } from "../logging/logger.js";
import { recordSessionEnd } from "../logging/session-recorder.js";
import { isEphemeralSessionState, type SessionBundle } from "../session/session-manager.js";
import type { GoalTerminationReason } from "../goal/lifecycle.js";
import type { Message, TokenUsage } from "../types.js";
import type { LLMClientBase } from "../llm/client-base.js";
import { buildSessionTitle } from "./session-title.js";
import { formatFriendlyError } from "./friendly-error.js";
import { stripInjectedContextMessages } from "./injected-context-cache.js";
import type { TurnLoop } from "./turn-loop.js";
import type { EngineResult } from "./types.js";
import type { EngineRunOptions } from "./run-types.js";
import type { RunBehaviorProfile } from "./run-types.js";

type TurnLoopRunResult = Awaited<ReturnType<TurnLoop["run"]>>;

/** engine.ts L2781-2830:headless 一次性 run 的后台子代理排水循环。 */
export async function drainHeadlessBackgroundAgents(args: {
  sid: string;
  session: SessionBundle;
  signal: AbortSignal | undefined;
  initialResult: TurnLoopRunResult;
  runTurnLoop: (messages: Message[]) => Promise<TurnLoopRunResult>;
  applyGoalTermination: (
    termination: GoalTerminationReason | undefined,
    round: number | undefined,
  ) => void;
  waitForBackgroundAgentChange: (sid: string, signal?: AbortSignal) => Promise<boolean>;
  waitForBackgroundAgentChangeOrTimeout: (sid: string, ms: number) => Promise<boolean>;
  getFirstGoalTermination: () => GoalTerminationReason | undefined;
  setFirstGoalTermination: (t: GoalTerminationReason | undefined) => void;
}): Promise<TurnLoopRunResult> {
  // 原样搬运 for(;;) 循环体;`result` 用局部变量承接 initialResult;
  // `firstGoalTermination ??= result.goalTermination` 改
  // `args.setFirstGoalTermination(args.getFirstGoalTermination() ?? result.goalTermination)`。
}

/** engine.ts L2847-3009:成功路径收尾(缓存/日志/钩子/记忆/标题/终态/结果)。 */
export async function finalizeRunSuccess(args: {
  session: SessionBundle;
  result: TurnLoopRunResult;
  firstGoalTermination: GoalTerminationReason | undefined;
  turnCount: number; // turnLoop.currentTurn
  getRunUsage: () => {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
  };
  usageBaseline: TokenUsage;
  userContextMsg: Message | undefined;
  dynamicContextMsg: Message | undefined;
  setCompactedMessages: (sid: string, messages: Message[]) => void;
  setLastMessages: (messages: Message[]) => void;
  options: EngineRunOptions | undefined;
  emitHook: (event: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  cwd: string;
  llmClient: LLMClientBase;
  auxSummaryClient: LLMClientBase;
  recordExternalBilledUsage: (usage: TokenUsage) => unknown;
  runMemoryPipeline: (
    transcript: SessionBundle["transcript"],
    sessionId: string,
    cwd: string,
    llmClient: LLMClientBase,
    recordExternalBilledUsage: (usage: TokenUsage) => unknown,
  ) => Promise<void> | void;
  updatePersistedSessionState: (sid: string, patch: Record<string, unknown>) => void;
  persistFinalRunState: (state: SessionBundle["state"]) => void;
  markRunAccountingFinalized: () => void;
  costStoreSerialize: (() => Record<string, unknown>) | undefined;
  profile: RunBehaviorProfile | undefined;
  getProfileReportedResults: () => Record<string, unknown> | undefined;
}): Promise<EngineResult> {
  // 原样搬运;`this.emitHook` → args.emitHook、`this.lastMessages = ...` →
  // args.setLastMessages(...)、`this.compactedMessagesBySession.set(...)` →
  // args.setCompactedMessages(...)、`void this.runMemoryPipeline(...)` →
  // `void args.runMemoryPipeline(...)`、`this.updatePersistedSessionState` /
  // `this.persistFinalRunState` → 对应回调、`runAccountingFinalized = true` →
  // args.markRunAccountingFinalized()、`this.config.costStore ...serialize()` →
  // args.costStoreSerialize、`turnLoop.currentTurn` → args.turnCount、
  // `profileReportedResults` → args.getProfileReportedResults()。
  // recordSessionEnd / logger / buildSessionTitle / stripInjectedContextMessages
  // 由模块自 import。
}

/** engine.ts L3011-3044 catch 体:初始化失败 → model_error 终态 + 错误结果。 */
export function buildRunFailureResult(args: {
  err: unknown;
  session: SessionBundle;
  options: EngineRunOptions | undefined;
  persistFinalRunState: (state: SessionBundle["state"]) => void;
}): EngineResult {
  // 原样搬运 catch 回调体(formatFriendlyError/appendError/logger/
  // recordSessionEnd/onStream error+turn_complete/usage 兜底)。
}
```

- [ ] **Step 3: engine.ts 侧替换**

try 块内(排水段原 L2781-2830):

```ts
        const sid = session.state.sessionId;
        const isTopLevel = this.config.isSubAgent !== true;
        if (isTopLevel && this.isHeadless()) {
          result = await drainHeadlessBackgroundAgents({
            sid,
            session,
            signal: options?.signal,
            initialResult: result,
            runTurnLoop: (msgs) => turnLoop.run(msgs),
            applyGoalTermination,
            waitForBackgroundAgentChange: (s, sig) => this.waitForBackgroundAgentChange(s, sig),
            waitForBackgroundAgentChangeOrTimeout: (s, ms) =>
              this.waitForBackgroundAgentChangeOrTimeout(s, ms),
            getFirstGoalTermination: () => firstGoalTermination,
            setFirstGoalTermination: (t) => {
              firstGoalTermination = t;
            },
          });
        }
```

成功收尾(原 L2847-3009)替换为:

```ts
      return await finalizeRunSuccess({
        session,
        result,
        firstGoalTermination,
        turnCount: turnLoop.currentTurn,
        getRunUsage,
        usageBaseline,
        userContextMsg,
        dynamicContextMsg,
        setCompactedMessages: (s, msgs) => this.compactedMessagesBySession.set(s, msgs),
        setLastMessages: (msgs) => {
          this.lastMessages = msgs;
        },
        options,
        emitHook: (event, payload, signal) =>
          this.emitHook(event as Parameters<Engine["emitHook"]>[0], payload, signal),
        cwd,
        llmClient,
        auxSummaryClient,
        recordExternalBilledUsage,
        runMemoryPipeline: (transcript, sessionId, runCwd, client, record) =>
          this.runMemoryPipeline(transcript, sessionId, runCwd, client, record),
        updatePersistedSessionState: (s, patch) =>
          this.updatePersistedSessionState(s, patch as SessionStateFieldPatch),
        persistFinalRunState: (state) => this.persistFinalRunState(state),
        markRunAccountingFinalized: () => accounting.markRunAccountingFinalized(),
        costStoreSerialize: this.config.costStore
          ? () => this.config.costStore!.serialize() as Record<string, unknown>
          : undefined,
        profile,
        getProfileReportedResults: () => profileReportedResults,
      });
```

catch 段(原 L3011-3044)替换为:

```ts
    return Promise.resolve(sessionRun).catch((err): EngineResult =>
      buildRunFailureResult({
        err,
        session,
        options,
        persistFinalRunState: (state) => this.persistFinalRunState(state),
      }),
    );
```

(`emitHook` 事件名类型若上面 `as` 写法与 `HookEventName` 冲突,改为 `emitHook: (event, payload, signal) => this.emitHook(event as HookEventName, payload, signal)`,以 typecheck 通过为准且不放宽模块签名。)删除被搬运行段;`recordSessionEnd`、`buildSessionTitle`、`stripInjectedContextMessages`、`formatFriendlyError`、`buildNotificationMessage`、`asyncAgentRegistry`(engine 其他处仍用则保留)等 import 按 lint 清理。

- [ ] **Step 4: C1 验证**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/run-finalize.ts packages/core/src/engine/engine.ts
git commit -m "refactor(core/engine): extract run-finalize (headless drain, epilogue, failure terminal)"
```

---

### Task 13: C1 收官 — runExclusive 骨架审计 + 全量门禁

**Files:**
- Modify(如审计需要): `packages/core/src/engine/engine.ts`

- [ ] **Step 1: 度量 runExclusive 本体行数**

```bash
awk '/private async runExclusive\(/{flag=1; start=NR} flag && /^  }$/{print NR-start+1; exit}' packages/core/src/engine/engine.ts
wc -l packages/core/src/engine/engine.ts
```

预期:第一条输出 **< 300**(骨架应约 230-290 行:输入准备 ~50、spawner/sandbox ~55、hooks 编排 ~70、TurnLoop 构造 ~180 已是最大留存块——若超标,把 TurnLoop options 对象整体提为 engine.ts 内私有方法 `buildTurnLoopWiring(...)` 即可达标,**不另建模块、不改行为**)。`engine.ts` 总行数应降至 ~2600 以下。

- [ ] **Step 2: 全量门禁**

```bash
bun test packages/core
bun test
bun run lint
bash scripts/check-no-engine-bypass.sh
bun test packages/core/src/engine/engine-import-boundary.test.ts
git diff --stat c366cc13 -- packages/core/src/protocol/   # 预期: 无输出(protocol 未动)
grep -rn "new Engine(" packages/core/src/engine/run-*.ts && echo VIOLATION || echo OK
```

预期:测试全绿、lint 通过、bypass OK、protocol 零 diff、最后一行 `OK`。

- [ ] **Step 3: Commit(若 Step 1 做了骨架内收尾整理)**

```bash
git add packages/core/src/engine/engine.ts
git commit -m "refactor(core/engine): finish runExclusive orchestration skeleton (<300 lines)"
```

---

## Self-review 记录(计划作者已核)

1. **Spec 覆盖**:设计文档工作流 C 四点 → C4=Task 1;C3=Task 2-4(3 个 example + README 链接;「不入构建链」经 workspaces/tsconfig/eslint/bun-test 四路核实为天然成立,无需排除配置);C2=Task 5(直迁路线偏离原 @deprecated 方案,依据 2026-07-15 已成事实的同类直迁 + 未发版窗口,breaking 记录在 commit + core README);C1=Task 6-13(四模块建议 → 七模块,差异及理由见 C1 章头表格)。
2. **占位符扫描**:所有「原样搬运」段均给出 HEAD 行号 + 起止锚点 + `this.*` 替换表,新增文件/测试/import 全部给出完整代码;无 TBD/TODO。
3. **类型一致性**:`RunWorkspaceResolution.profileState` ↔ Task 6 调用点解构;`OpenedRunSession.releaseClientMessageId` ↔ Task 7 TurnLoop 接线;`RunUsageAccounting.markRunAccountingFinalized` ↔ Task 12 `finalizeRunSuccess` 参数;`GoalRunSlots` ↔ Task 11 两函数与 engine 槽位;`createGoalTerminationApplier` 返回签名 ↔ Task 12 `applyGoalTermination` 参数——已交叉核对命名一致。
