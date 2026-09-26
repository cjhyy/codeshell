# 优化实验室执行计划（路线图 + 计划 A：地基）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 设计来源：`docs/todo/optimization-lab-mvp.md`（内置能力包版本）。
> 代码事实基线：`origin/main` @ `ae600ba9`（2026-09-26 调研）。执行时若 `origin/main` 已前进，先按 Task 0 重新核对本文引用的行号。
> 原则：每个 Task 先 RED 再最小实现；每个 Task 一条 Conventional Commit；只 `prettier --write` 改过的文件，不跑 `bun run format`；测试门禁用 `bun test packages tests`，不跑裸 `bun test`。

**Goal:** 分三份子计划交付优化实验室的 P0 + P1a。本文先把计划 A（Core 导出、私有能力包、Desktop 按开关加载、样本校验与冻结）写到可直接执行的粒度。

**Architecture:** 新增私有能力包 `packages/optimization-lab`（`@cjhyy/code-shell-capability-optimization-lab`），以 AgentModule 形式由 Desktop agent worker 按 feature flag `optimization_lab`（默认关）加载。包只 import `@cjhyy/code-shell-core/extension`。Core 只新增三项经核实的导出：只读 Skill 快照、跨进程文件锁、文本连接解析。

**Tech Stack:** Bun + TypeScript（ESM）、`bun:test`、zod 3、Electron（Desktop main/renderer）。

---

## 路线图

| 顺序 | 计划                                | 交付物                                                                                                | 通过标准                                                       | 状态                                                                    |
| ---- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 0    | 集成前置                            | 本地 `main` 与 `origin/main` 合流；方案分支合入                                                       | `bun test packages tests` 与 typecheck 全绿                    | 本文 Task 0                                                             |
| A    | 地基（P0 + Core 导出 + 按开关加载） | 私有包可构建、可打包、开关打开时被 worker 加载；样本可校验、切分、冻结出 dataset hash                 | 本文 Task 1–12 全部完成；不发出任何模型请求                    | 本文详细展开                                                            |
| B    | P1a 引擎                            | 计量 fetch 与预算账本、租约、控制器状态机、文本 runner、`reflect_once_v1`、判分检查点与盲评模板、报告 | 离线测试覆盖方案 §14 全部 `[P1a]` 项（用假 fetch，不花钱）     | A 合入后另写 `docs/superpowers/plans/<date>-optimization-lab-engine.md` |
| C    | P1a 接入                            | Desktop main 转发与 worker 保活、最小授权页（轮询状态）、评分 JSON 导出/回填                          | 在 Desktop 中授权并跑完一次真实实验，产出 JSON + Markdown 报告 | B 合入后另写 `...-optimization-lab-desktop.md`                          |

B、C 依赖 A 定下的类型和存储布局，所以等 A 合入后再按实际代码写细，避免计划与代码脱节。

B 的任务清单（写计划时逐项展开）：

1. `BudgetLedger`：`ledger.jsonl` 追加写（短暂加锁、修复截断尾行）、预留/结算/`unknown`、Token 与执行时间两种资源、最终阶段预留。
2. 实验租约：`lease.json`（owner、workerGeneration、heartbeatAt），接管规则。
3. 计量 fetch：包装 `ClientDefaults.fetch`，每次 HTTP 请求先预留后发送，非流式响应读取 `model` 与 usage；`retryMaxAttempts: 1`。
4. `ExperimentPlan` / `BudgetGrant` 契约，以及 `planHash` 和 `expiresAt` 校验。
5. 控制器状态机（方案 §10），包括两个判分等待态与可恢复状态。
6. 文本 runner 与确定性断言求值（`contains` / `not_contains` / `json_field_equals`）。
7. `reflect_once_v1`：生成候选正文，静态校验（frontmatter 不变、字节上限、`extraFiles` 必须为 `[]`）。
8. 判分：盲评模板导出、回填导入与校验。
9. 报告：改动（含开发集过拟合提示）→ 效果 → 分母 → 成本 → 限制；JSON + Markdown。

C 的任务清单：

1. Desktop main：确保 worker 在线后转发 `agent/query`（只有 `agent/run` 会按需拉起 worker）。
2. preload 新增 `optimizationLab.*` 调用，不新增通知通道，改用轮询。
3. renderer：`PAGE_REGISTRY.register` 按开关注册最小授权页。
4. 真实验收：作者自选的一类任务，产出一份真实报告（可以是“没有改进”）。

---

## 文件结构（计划 A）

| 文件                                                                                                                                                                                                              | 职责                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/core/src/skills/snapshot.ts`（新）                                                                                                                                                                      | `readSkillSnapshot(name, cwd)`：只读 Skill 快照与 revision |
| `packages/core/src/skills/snapshot.test.ts`（新）                                                                                                                                                                 | 快照测试                                                   |
| `packages/core/src/index.extension.ts`（改）                                                                                                                                                                      | 新增三行导出                                               |
| `packages/core/src/index.exports.test.ts`（改）                                                                                                                                                                   | `/extension` 契约与单例一致性                              |
| `tests/architecture-budgets.test.ts`（改）                                                                                                                                                                        | `index.extension.ts` 导出预算 46 → 49                      |
| `packages/core/src/settings/feature-flags.ts` + `.test.ts`（改）                                                                                                                                                  | 新增 `optimization_lab`（默认关）                          |
| `packages/optimization-lab/**`（新）                                                                                                                                                                              | 私有能力包                                                 |
| `tests/optimization-lab-composition.test.ts`（新）                                                                                                                                                                | 与 Desktop 现有模块组合不冲突                              |
| 根 `package.json`、`tsconfig.json`、`Dockerfile`、`.github/workflows/ci.yml`、`eslint.config.js`、`scripts/package-release-audit-config.ts`、`tests/package-boundaries.test.ts`、`bun.lock`、`CODESHELL.md`（改） | 新包登记                                                   |
| `packages/desktop/package.json`、`scripts/build-workspace-dependencies.ts`、`scripts/predist.ts`（改）                                                                                                            | Desktop 打包                                               |
| `packages/desktop/src/main/capability-modules-env.ts` + `.test.ts`（新）                                                                                                                                          | 按开关组装 `CODE_SHELL_CAPABILITY_MODULES`                 |
| `packages/desktop/src/main/agent-bridge.ts`（改）                                                                                                                                                                 | 改用上面的组装函数                                         |

包内结构：

```text
packages/optimization-lab/
  package.json  tsconfig.json  bunfig.toml
  src/
    index.ts                 根入口（测试与宿主用）
    index.capability.ts      只导出 createOptimizationLabModule
    module.ts                AgentModule 工厂
    queries.ts               protocol queries（optimization_lab_*）
    store-paths.ts           labRoot / projectKey
    contracts/
      canonical-json.ts      稳定序列化 + sha256
      verdict-policy.ts      复制自 evals/harness/cases.json
      eval-case.ts           zod schemas
      dataset.ts             validateDataset / freezeDataset
    *.test.ts / contracts/*.test.ts
```

---

## Task 0：集成前置（需要仓库负责人确认后执行）

截至 2026-09-26：本地 `main` 比 `origin/main` 多 12 个提交（包含方案文档 `580033ad`、`fc3e528d`），`origin/main` 比本地多 58 个提交；方案分支 `codex/docs/optimization-lab-builtin` 是本地 `main` 的快进。arena 移除提交只在 `codex/arena/remove-call-sites` 上，不在 `origin/main`。

- [ ] **Step 1: 在独立 worktree 合流，不动任何活跃 checkout**

```bash
git fetch origin
git worktree add -b codex/integration/main-sync ../wt-main-sync main
cd ../wt-main-sync
git merge --no-ff origin/main
```

有冲突时逐个解决，不用 `-X ours`，也不丢弃未知改动（CODESHELL.md 分支规则）。

- [ ] **Step 2: 合入方案分支**

```bash
git merge --no-ff codex/docs/optimization-lab-builtin
```

- [ ] **Step 3: 验证**

```bash
bun install
bun run typecheck
bun test packages tests
```

Expected: 全部通过。失败时先确认是否合流前就已失败（用 `origin/main` worktree 对照）。

- [ ] **Step 4: 快进 main 并推送（推送需负责人确认）**

```bash
git -C <主仓库路径> fetch . codex/integration/main-sync:main
git push origin main
```

- [ ] **Step 5: 为计划 A 开任务分支**

```bash
git worktree add -b codex/optimization-lab/foundation ../wt-optlab-foundation main
```

之后所有 Task 都在 `../wt-optlab-foundation` 中执行。**如果 arena 移除已先合入 main**：Task 6、Task 9 中出现的 `arena` 条目一律删掉，其余不变。

---

## Task 1：Core 只读 Skill 快照

**Files:**

- Create: `packages/core/src/skills/snapshot.ts`
- Test: `packages/core/src/skills/snapshot.test.ts`

背景：`scanSkills(cwd)`（`skills/scanner.ts:414`）按名字找 Skill，`content` 已去掉 frontmatter；`readSkillBundle(dir)`（`skills/management.ts:174`）给出整个目录的 revision 和完整 SKILL.md，遇到符号链接会抛错；`parseFrontmatter`（`skills/frontmatter.ts:18`）拆分 frontmatter 与正文。hub 对无法管理的 Skill 用 `sha256(content)` 作 revision（`server/src/hub/skills-management.ts:149-162`），这里同样回退，但标出 `revisionKind`，并把 `extraFiles` 设为 `null`（未知），让调用方可以保守拒绝。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/src/skills/snapshot.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateSkillCache } from "./scanner.js";
import { readSkillSnapshot } from "./snapshot.js";

const NAME = "optlab-snapshot-probe";
const MD =
  "---\nname: optlab-snapshot-probe\ndescription: Probe skill\n---\n# Steps\n1. Cite sources.\n";
const roots: string[] = [];

function project(markdown = MD): { cwd: string; skillDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "optlab-snapshot-"));
  roots.push(cwd);
  const skillDir = join(cwd, ".code-shell", "skills", NAME);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), markdown);
  invalidateSkillCache();
  return { cwd, skillDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  invalidateSkillCache();
});

describe("readSkillSnapshot", () => {
  test("returns the full markdown, split frontmatter/body and a bundle revision", () => {
    const { cwd } = project();
    const snapshot = readSkillSnapshot(NAME, cwd);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.markdown).toBe(MD);
    expect(snapshot!.frontmatter).toEqual({ name: NAME, description: "Probe skill" });
    expect(snapshot!.body).toBe("# Steps\n1. Cite sources.\n");
    expect(snapshot!.source).toBe("project");
    expect(snapshot!.revisionKind).toBe("bundle");
    expect(snapshot!.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot!.extraFiles).toEqual([]);
  });

  test("returns null for an unknown skill", () => {
    const { cwd } = project();
    expect(readSkillSnapshot("optlab-no-such-skill", cwd)).toBeNull();
  });

  test("lists extra bundle files so callers can reject non-text skills", () => {
    const { cwd, skillDir } = project();
    mkdirSync(join(skillDir, "scripts"));
    writeFileSync(join(skillDir, "scripts", "run.sh"), "echo hi\n");
    invalidateSkillCache();
    expect(readSkillSnapshot(NAME, cwd)!.extraFiles).toEqual(["scripts/run.sh"]);
  });

  test("changes revision when the body changes", () => {
    const { cwd, skillDir } = project();
    const before = readSkillSnapshot(NAME, cwd)!.revision;
    writeFileSync(join(skillDir, "SKILL.md"), MD.replace("Cite sources.", "Cite every source."));
    invalidateSkillCache();
    expect(readSkillSnapshot(NAME, cwd)!.revision).not.toBe(before);
  });

  test("falls back to a markdown-only revision when the bundle cannot be walked", () => {
    const { cwd, skillDir } = project();
    symlinkSync(join(skillDir, "SKILL.md"), join(skillDir, "alias.md"));
    invalidateSkillCache();
    const snapshot = readSkillSnapshot(NAME, cwd)!;
    expect(snapshot.revisionKind).toBe("markdown");
    expect(snapshot.extraFiles).toBeNull();
    expect(snapshot.markdown).toBe(MD);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/core/src/skills/snapshot.test.ts`
Expected: FAIL，`Cannot find module './snapshot.js'`。

如果实现之后第一个用例仍拿到 `null`，说明项目级 Skill 没被扫描到：对照 `packages/core/src/skills/scanner.test.ts` 的临时项目写法（是否需要信任项目或设置 HOME）调整 `project()`，不要改扫描器。

- [ ] **Step 3: 最小实现**

```ts
// packages/core/src/skills/snapshot.ts
/**
 * Read-only Skill snapshot for capability packages. Unlike /internal/skills it
 * never edits, installs or stages anything: it answers "what exactly is this
 * Skill's text right now, and which revision is it".
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { MAX_SKILL_MARKDOWN_BYTES, readSkillBundle } from "./management.js";
import { scanSkills, type SkillDefinition } from "./scanner.js";

export interface SkillSnapshot {
  name: string;
  source: SkillDefinition["source"];
  filePath: string;
  /** Full SKILL.md text, frontmatter included. */
  markdown: string;
  frontmatter: Record<string, unknown>;
  /** SKILL.md with the frontmatter block removed. */
  body: string;
  revision: string;
  /**
   * "bundle": readSkillBundle walked the whole directory (the revision Skill
   * editors use). "markdown": the directory could not be walked (for example it
   * contains a symlink), so the revision covers SKILL.md only.
   */
  revisionKind: "bundle" | "markdown";
  /** Bundle files other than SKILL.md; null when the directory could not be walked. */
  extraFiles: string[] | null;
}

export function readSkillSnapshot(name: string, cwd: string): SkillSnapshot | null {
  const skill = scanSkills(cwd).find((candidate) => candidate.name === name);
  if (!skill) return null;
  let markdown: string;
  let revision: string;
  let revisionKind: SkillSnapshot["revisionKind"];
  let extraFiles: string[] | null;
  try {
    const bundle = readSkillBundle(dirname(skill.filePath));
    markdown = bundle.content;
    revision = bundle.revision;
    revisionKind = "bundle";
    extraFiles = bundle.files.map((file) => file.path).filter((path) => path !== "SKILL.md");
  } catch {
    if (statSync(skill.filePath).size > MAX_SKILL_MARKDOWN_BYTES) {
      throw new Error(`Skill ${name}: SKILL.md exceeds ${MAX_SKILL_MARKDOWN_BYTES} bytes`);
    }
    markdown = readFileSync(skill.filePath, "utf8");
    revision = createHash("sha256").update(markdown).digest("hex");
    revisionKind = "markdown";
    extraFiles = null;
  }
  const { frontmatter, body } = parseFrontmatter(markdown);
  return {
    name: skill.name,
    source: skill.source,
    filePath: skill.filePath,
    markdown,
    frontmatter,
    body,
    revision,
    revisionKind,
    extraFiles,
  };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test packages/core/src/skills/snapshot.test.ts`
Expected: 5 pass, 0 fail。

- [ ] **Step 5: 提交**

```bash
./node_modules/.bin/prettier --write packages/core/src/skills/snapshot.ts packages/core/src/skills/snapshot.test.ts
git add packages/core/src/skills/snapshot.ts packages/core/src/skills/snapshot.test.ts
git commit -m "feat(core): add read-only skill snapshot"
```

---

## Task 2：`/extension` 新增三项导出

**Files:**

- Modify: `packages/core/src/index.extension.ts`（在 `export { SessionManager, codeShellHome } ...` 那一行之后）
- Modify: `packages/core/src/index.exports.test.ts`（`extensionRuntimeContract` 约在 `:298-313`；extension 用例约在 `:370-396`）
- Modify: `tests/architecture-budgets.test.ts`（`"packages/core/src/index.extension.ts": 46`，约在 `:174`）

背景：`acquireLockOnPath`、`mutateJsonFile` 目前只在 `/internal`（`index.internal.ts:55`）；`resolveLLMConfigForTag` 只在根入口（`index.ts:93`）。能力包按 ESLint 规则只能 import `/extension`（`eslint.config.js:264-269`）。`index.extension.ts` 现有 46 条 `export` 语句，正好等于预算，所以必须同时调高预算并写明理由。

- [ ] **Step 1: 写失败测试**：在 `extensionRuntimeContract` 数组末尾（`"logger",` 之后）加：

```ts
  "readSkillSnapshot",
  "acquireLockOnPath",
  "mutateJsonFile",
  "resolveLLMConfigForTag",
```

在 `"exposes the capability contract from the extension entry with singleton identity"` 用例中、`notificationQueue` 断言之后加：

```ts
// Optimization Lab host reads re-export the existing implementations; they
// must be the same functions hosts already use, not parallel copies.
expect(extensionApi.acquireLockOnPath).toBe(internalApi.acquireLockOnPath);
expect(extensionApi.mutateJsonFile).toBe(internalApi.mutateJsonFile);
expect(extensionApi.resolveLLMConfigForTag).toBe(
  (publicApi as Record<string, unknown>).resolveLLMConfigForTag,
);
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/core/src/index.exports.test.ts`
Expected: FAIL，`/extension must export readSkillSnapshot`。

- [ ] **Step 3: 实现**：在 `index.extension.ts` 的 `export { SessionManager, codeShellHome } from "./session/session-manager.js";` 之后加：

```ts
// Optimization Lab host reads (docs/todo/optimization-lab-mvp.md §5.2). Each is
// an existing implementation re-exported for capability packages: an exact
// read-only Skill snapshot, the shared cross-process file lock, and the text
// connection resolver. None grants Skill editing or credential access.
export { readSkillSnapshot, type SkillSnapshot } from "./skills/snapshot.js";
export { acquireLockOnPath, mutateJsonFile } from "./utils/file-mutex.js";
export { resolveLLMConfigForTag } from "./engine/resolve-llm-config.js";
```

并把 `tests/architecture-budgets.test.ts` 中的预算改为：

```ts
      // +3 for the reviewed Optimization Lab host reads (Skill snapshot, shared
      // file lock, text-connection resolver); each re-exports an existing
      // implementation, see docs/todo/optimization-lab-mvp.md §5.2.
      "packages/core/src/index.extension.ts": 49,
```

- [ ] **Step 4: 运行，确认通过**

```bash
bun test packages/core/src/index.exports.test.ts tests/architecture-budgets.test.ts
bun run --filter '@cjhyy/code-shell-core' typecheck
```

Expected: 全部 PASS，typecheck 无错误。

- [ ] **Step 5: 重建 core 并跑下游**（下游包测试吃的是 core 的 `dist`）

```bash
bun run --filter '@cjhyy/code-shell-core' build
bun test packages/pet packages/coding
```

Expected: 与改动前结果一致。

- [ ] **Step 6: 提交**

```bash
./node_modules/.bin/prettier --write packages/core/src/index.extension.ts packages/core/src/index.exports.test.ts tests/architecture-budgets.test.ts
git add packages/core/src/index.extension.ts packages/core/src/index.exports.test.ts tests/architecture-budgets.test.ts
git commit -m "feat(core): expose skill snapshot, file lock and text resolver to capabilities"
```

---

## Task 3：feature flag `optimization_lab`

**Files:**

- Modify: `packages/core/src/settings/feature-flags.ts`（`FEATURE_FLAGS` 对象末尾，`external_host_tools` 之后）
- Test: `packages/core/src/settings/feature-flags.test.ts`（`featureFlagNames lists every known flag`，约在 `:36-46`）

- [ ] **Step 1: 写失败测试**：把 `featureFlagNames` 用例的期望数组改为：

```ts
expect([...featureFlagNames()].sort()).toEqual([
  "external_agent_runtime",
  "external_host_tools",
  "fast_mode",
  "optimization_lab",
  "shell_snapshot",
  "shell_tool",
  "undo",
  "web_search",
]);
```

并在同一 `describe` 内新增：

```ts
test("optimization_lab defaults OFF and can be switched on", () => {
  expect(isFeatureEnabled({}, "optimization_lab")).toBe(false);
  expect(isFeatureEnabled({ optimization_lab: true }, "optimization_lab")).toBe(true);
});
```

（如该文件尚未 import `isFeatureEnabled`，在顶部 import 中补上。）

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/core/src/settings/feature-flags.test.ts`
Expected: FAIL，数组缺少 `optimization_lab`。

- [ ] **Step 3: 实现**：在 `external_host_tools: {...},` 之后加：

```ts
  /**
   * Optimization Lab (docs/todo/optimization-lab-mvp.md). Default OFF until the
   * P1a report shows the method is worth keeping. While off, Desktop does not
   * load the module, so there is no entry point and no working directory.
   */
  optimization_lab: {
    default: false,
    description: "Load the experimental Optimization Lab module in Desktop",
  },
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test packages/core/src/settings/feature-flags.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
./node_modules/.bin/prettier --write packages/core/src/settings/feature-flags.ts packages/core/src/settings/feature-flags.test.ts
git add packages/core/src/settings/feature-flags.ts packages/core/src/settings/feature-flags.test.ts
git commit -m "feat(core): add default-off optimization_lab feature flag"
```

---

## Task 4：私有能力包骨架

**Files:**

- Create: `packages/optimization-lab/package.json`、`tsconfig.json`、`bunfig.toml`
- Create: `packages/optimization-lab/src/module.ts`、`src/index.capability.ts`、`src/index.ts`
- Test: `packages/optimization-lab/src/index.exports.test.ts`、`src/module.test.ts`
- Modify: 根 `tsconfig.json` 的 `paths`（在 `@cjhyy/code-shell-pet/disclosure` 那行之后）

- [ ] **Step 1: 确认版本号**

Run: `node -p "require('./package.json').version"`
Expected: 输出当前发布版本（调研时为 `0.9.22`）。下面 `package.json` 的 `version` 必须与之相同，否则 `scripts/verify-release-versions.ts` 会失败。

- [ ] **Step 2: 写包清单与配置**

```json
{
  "name": "@cjhyy/code-shell-capability-optimization-lab",
  "version": "0.9.22",
  "private": true,
  "description": "Optimization Lab capability for CodeShell — budgeted, reviewable Skill optimization experiments.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./capability": {
      "types": "./dist/index.capability.d.ts",
      "import": "./dist/index.capability.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "bun run clean && tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "clean": "node -e \"require('node:fs').rmSync('dist',{recursive:true,force:true})\""
  },
  "dependencies": {
    "@cjhyy/code-shell-core": "workspace:*",
    "zod": "^3.24.2"
  },
  "engines": {
    "node": ">=20.10"
  },
  "license": "MIT"
}
```

`packages/optimization-lab/tsconfig.json` 与 `packages/pet/tsconfig.json` 完全相同：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noImplicitAny": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": false,
    "sourceMap": false,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

`packages/optimization-lab/bunfig.toml`：

```toml
[test]
# Match the repository-level test contract even when tests are launched with
# packages/optimization-lab as the working directory.
timeout = 30000
# Redirect .code-shell home to a temp dir so lab stores written through
# codeShellHome() never land in the developer's real ~/.code-shell.
preload = ["../core/test-setup.ts"]
```

根 `tsconfig.json` 的 `paths` 中，在 `"@cjhyy/code-shell-pet/disclosure": [...]` 之后加：

```json
      "@cjhyy/code-shell-capability-optimization-lab": ["packages/optimization-lab/src/index.ts"],
      "@cjhyy/code-shell-capability-optimization-lab/capability": [
        "packages/optimization-lab/src/index.capability.ts"
      ],
```

- [ ] **Step 3: 写失败测试**

```ts
// packages/optimization-lab/src/index.exports.test.ts
import { describe, expect, it } from "bun:test";
import * as capabilityApi from "./index.capability.js";
import * as rootApi from "./index.js";

describe("optimization-lab package entry contracts", () => {
  it("keeps the capability entry to the module factory", () => {
    expect(Object.keys(capabilityApi).sort()).toEqual(["createOptimizationLabModule"]);
    expect(capabilityApi.createOptimizationLabModule).toBe(rootApi.createOptimizationLabModule);
  });

  it("stays private with only the root and capability subpaths", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./capability"]);
  });
});
```

```ts
// packages/optimization-lab/src/module.test.ts
import { describe, expect, test } from "bun:test";
import { createOptimizationLabModule } from "./module.js";

describe("createOptimizationLabModule", () => {
  test("uses a valid composition id", () => {
    expect(createOptimizationLabModule().id).toBe("optimization-lab");
  });

  test("namespaces every protocol query", () => {
    const queries = createOptimizationLabModule().protocol?.queries ?? {};
    for (const name of Object.keys(queries)) {
      expect(name.startsWith("optimization_lab_")).toBe(true);
    }
  });
});
```

- [ ] **Step 4: 运行，确认失败**

Run: `bun test packages/optimization-lab`
Expected: FAIL，`Cannot find module './index.capability.js'`。

- [ ] **Step 5: 最小实现**

```ts
// packages/optimization-lab/src/module.ts
import type { AgentModule } from "@cjhyy/code-shell-core/extension";

export const OPTIMIZATION_LAB_MODULE_ID = "optimization-lab";

/** Optimization Lab as an AgentModule. Queries are added as the lab grows. */
export function createOptimizationLabModule(): AgentModule {
  return { id: OPTIMIZATION_LAB_MODULE_ID, protocol: { queries: {} } };
}
```

```ts
// packages/optimization-lab/src/index.capability.ts
export { createOptimizationLabModule } from "./module.js";
```

```ts
// packages/optimization-lab/src/index.ts
export { createOptimizationLabModule } from "./module.js";
```

- [ ] **Step 6: 安装并运行**

```bash
bun install
bun test packages/optimization-lab
bun run --filter '@cjhyy/code-shell-capability-optimization-lab' typecheck
```

Expected: `bun.lock` 新增 `packages/optimization-lab` 工作区条目；测试 3 pass；typecheck 无错误。

- [ ] **Step 7: 提交**

```bash
./node_modules/.bin/prettier --write packages/optimization-lab tsconfig.json
git add packages/optimization-lab tsconfig.json bun.lock
git commit -m "feat(optimization-lab): scaffold private capability package"
```

---

## Task 5：与 Desktop 现有模块组合

**Files:**

- Test: `tests/optimization-lab-composition.test.ts`

不改 `tests/composition-golden.test.ts` 和 `tests/fixtures/composition-golden.json`：golden 用它自己写死的模块列表，Desktop 按开关加载新模块不影响它，fixture 也禁止随手重生成。

- [ ] **Step 1: 写测试**

```ts
// tests/optimization-lab-composition.test.ts
import { describe, expect, test } from "bun:test";
import { createArenaModule } from "@cjhyy/code-shell-arena";
import { createCodingModule } from "@cjhyy/code-shell-capability-coding";
import { createOptimizationLabModule } from "@cjhyy/code-shell-capability-optimization-lab";
import { createPetModule } from "@cjhyy/code-shell-pet";
import { compileComposition } from "../packages/core/src/composition/compiler.js";
import type { AgentModule } from "../packages/core/src/composition/types.js";

describe("optimization lab composition", () => {
  test("appending it after the Desktop module set compiles without key collisions", () => {
    expect(() =>
      compileComposition({
        modules: [
          createCodingModule() as unknown as AgentModule,
          createArenaModule() as unknown as AgentModule,
          createPetModule() as unknown as AgentModule,
          createOptimizationLabModule() as unknown as AgentModule,
        ],
        expectedModules: ["coding", "arena", "pet", "optimization-lab"],
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行**

Run: `bun test tests/optimization-lab-composition.test.ts tests/composition-golden.test.ts`
Expected: 两个文件都 PASS（golden 未受影响）。

- [ ] **Step 3: 提交**

```bash
./node_modules/.bin/prettier --write tests/optimization-lab-composition.test.ts
git add tests/optimization-lab-composition.test.ts
git commit -m "test: compose optimization lab with the desktop module set"
```

---

## Task 6：仓库级登记

**Files（逐项修改）:**

- 根 `package.json:20` `build` 链
- `Dockerfile:9-20`
- `.github/workflows/ci.yml` 的 `rest` 分片（约 `:104-108`）
- `eslint.config.js:15-27`、`:28`、`:438-447`
- `scripts/package-release-audit-config.ts`（`RELEASE_PACKAGES` 末尾）
- `tests/package-boundaries.test.ts:119-125`、`:199-202`
- `CODESHELL.md:10`、`:121`、`:152`

- [ ] **Step 1: 先跑守卫，确认失败**

```bash
bun scripts/verify-release-versions.ts
bun test tests/package-boundaries.test.ts
```

Expected: 两者都 FAIL，报 `packages/optimization-lab/package.json` 未在 `RELEASE_PACKAGES` 中声明。

- [ ] **Step 2: `scripts/package-release-audit-config.ts`**：在 `packages/desktop` 那一项之后加：

```ts
  {
    directory: "packages/optimization-lab",
    name: "@cjhyy/code-shell-capability-optimization-lab",
    publish: false,
  },
```

- [ ] **Step 3: `tests/package-boundaries.test.ts`**

能力包清单（约 `:119-125`）改为：

```ts
    for (const capability of [
      "@cjhyy/code-shell-capability-coding",
      "@cjhyy/code-shell-arena",
      "@cjhyy/code-shell-pet",
      "@cjhyy/code-shell-capability-optimization-lab",
    ]) {
```

私有包清单（约 `:199-202`）改为：

```ts
expect(PRIVATE_VERSIONED_PACKAGES.map((definition) => definition.name).sort()).toEqual([
  "@cjhyy/code-shell-capability-optimization-lab",
  "@cjhyy/code-shell-cdp",
  "@cjhyy/code-shell-desktop",
]);
```

- [ ] **Step 4: 根 `package.json` 的 `build`**：在 `bun run --filter '@cjhyy/code-shell-pet' build && ` 之后插入：

```text
bun run --filter '@cjhyy/code-shell-capability-optimization-lab' build &&
```

- [ ] **Step 5: `Dockerfile`**：在 `COPY packages/link/package.json packages/link/package.json` 之后加：

```dockerfile
COPY packages/optimization-lab/package.json packages/optimization-lab/package.json
```

- [ ] **Step 6: `.github/workflows/ci.yml`**：`rest` 分片的 `paths` 末尾追加 `packages/optimization-lab`：

```yaml
paths: >-
  tests packages/coding packages/tui packages/pet packages/server
  packages/chat packages/web packages/arena packages/cdp
  packages/link packages/optimization-lab
```

- [ ] **Step 7: `eslint.config.js`**
  - `workspacePackageRoots` 数组在 `"pet",` 之后加 `"optimization-lab",`。
  - `capabilityPackageRoots` 改为 `["coding", "arena", "pet", "optimization-lab"]`。
  - 启用 `custom-rules/codeshell-boundary-imports` 的 `files` 数组加一行 `"packages/optimization-lab/src/**/*.{ts,tsx}",`。

- [ ] **Step 8: `CODESHELL.md`**：把 `:10`、`:152` 的包数量 11 改为 12；在 `:121` 的构建顺序注释中，把新包放在 pet 之后。

- [ ] **Step 9: 验证**

```bash
bun scripts/verify-release-versions.ts
bun test tests/package-boundaries.test.ts tests/publish-release-packages.test.ts
./node_modules/.bin/eslint packages/optimization-lab/src
```

Expected: 全部通过。

- [ ] **Step 10: 验证边界规则真的生效**：临时新建 `packages/optimization-lab/src/__probe__.ts`，内容为 `import "@cjhyy/code-shell-core/internal";`，运行 `./node_modules/.bin/eslint packages/optimization-lab/src/__probe__.ts`。Expected：报 `capabilityToCoreEntry`。确认后删除该文件。

- [ ] **Step 11: 提交**

```bash
./node_modules/.bin/prettier --write package.json eslint.config.js scripts/package-release-audit-config.ts tests/package-boundaries.test.ts .github/workflows/ci.yml CODESHELL.md
git add package.json Dockerfile .github/workflows/ci.yml eslint.config.js scripts/package-release-audit-config.ts tests/package-boundaries.test.ts CODESHELL.md
git commit -m "build: register the private optimization lab package"
```

---

## Task 7：Desktop 打包

**Files:**

- Modify: `packages/desktop/package.json`（`dependencies`）
- Modify: `packages/desktop/scripts/build-workspace-dependencies.ts:9-27`
- Modify: `packages/desktop/scripts/predist.ts`

背景：Desktop 通过 `import.meta.resolve` 在运行时引用能力包，所以新包必须是运行时 `dependency`，并且要物化到 `node_modules`。新包直接依赖 zod，要和 arena 一样单独安装生产依赖。

- [ ] **Step 1: 先改依赖，确认守卫失败**：在 `packages/desktop/package.json` 的 `dependencies` 里、`"@cjhyy/code-shell-capability-coding"` 之后加：

```json
    "@cjhyy/code-shell-capability-optimization-lab": "workspace:*",
```

Run: `bun install && bun test packages/desktop/scripts/build-workspace-dependencies.test.ts`
Expected: FAIL，构建顺序表与 desktop 的 workspace 依赖不一致。

- [ ] **Step 2: 构建顺序**：在 `build-workspace-dependencies.ts` 的 pet 条目之后加：

```ts
  {
    label: "optimization-lab",
    packageName: "@cjhyy/code-shell-capability-optimization-lab",
    relativeDir: "packages/optimization-lab",
  },
```

Run: `bun test packages/desktop/scripts/build-workspace-dependencies.test.ts`
Expected: PASS。

- [ ] **Step 3: `predist.ts`**，逐处修改：

常量区（`petTarget` 之后）：

```ts
const optimizationLabSrc = resolve(repoRoot, "packages/optimization-lab");
const optimizationLabTarget = resolve(
  desktopRoot,
  "node_modules/@cjhyy/code-shell-capability-optimization-lab",
);
```

`main()` 的存在性检查（pet 检查之后）：

```ts
if (!existsSync(optimizationLabSrc)) {
  throw new Error(`Optimization Lab package not found at ${optimizationLabSrc}`);
}
```

移除与物化（各自紧跟 pet 那一行之后）：

```ts
removeWorkspaceTarget(optimizationLabTarget, "Optimization Lab");
```

```ts
materializePackage(optimizationLabSrc, optimizationLabTarget);
```

生产依赖（`installProductionDeps(arenaSrc, ...)` 之后）：

```ts
installProductionDeps(optimizationLabSrc, optimizationLabTarget, "Optimization Lab");
```

`verifyMaterializedCapabilities()` 的 eval 字符串末尾追加：

```text
; await import('@cjhyy/code-shell-capability-optimization-lab/capability')
```

日志改为 `materialized Link + core + coding + Arena + Pet + Optimization Lab into node_modules (LICENSE/README excluded)`。

- [ ] **Step 4: 验证**

```bash
bun test packages/desktop/scripts
bun run --filter '@cjhyy/code-shell-capability-optimization-lab' build
```

Expected: PASS；`packages/optimization-lab/dist/index.capability.js` 存在。

完整的 `predist` 会构建全部包和 Desktop 产物，耗时较长：放到 Task 12 统一跑一次。

- [ ] **Step 5: 提交**

```bash
./node_modules/.bin/prettier --write packages/desktop/package.json packages/desktop/scripts/build-workspace-dependencies.ts packages/desktop/scripts/predist.ts
git add packages/desktop/package.json packages/desktop/scripts/build-workspace-dependencies.ts packages/desktop/scripts/predist.ts bun.lock
git commit -m "build(desktop): package the optimization lab capability"
```

---

## Task 8：Desktop 按开关加载模块

**Files:**

- Create: `packages/desktop/src/main/capability-modules-env.ts`
- Test: `packages/desktop/src/main/capability-modules-env.test.ts`
- Modify: `packages/desktop/src/main/agent-bridge.ts:326-335`（`buildEnv`）

背景：`buildEnv` 在每次拉起 worker 时调用，所以开关切换会在下一次拉起 worker 时生效。新包只在开关打开时才 `import.meta.resolve`，这样开关关闭时，即使包缺失也不会影响 worker。Desktop main 目前按用户级设置读取开关（`main/index.ts:1524-1530`），这里保持同样的口径。

- [ ] **Step 1: 写失败测试**

```ts
// packages/desktop/src/main/capability-modules-env.test.ts
import { describe, expect, test } from "bun:test";
import { composeCapabilityModulesEnv } from "./capability-modules-env.js";

const urls = { coding: "file:///c.js", arena: "file:///a.js", pet: "file:///p.js" };
const mustNotResolve = () => {
  throw new Error("optimization lab must not be resolved while its flag is off");
};

describe("composeCapabilityModulesEnv", () => {
  test("keeps the existing three modules, in order, when the flag is off", () => {
    expect(composeCapabilityModulesEnv(urls, {}, mustNotResolve)).toBe(
      "file:///c.js#createCodingModule,file:///a.js#createArenaModule,file:///p.js#createPetModule",
    );
  });

  test("appends the optimization lab module last when the flag is on", () => {
    expect(
      composeCapabilityModulesEnv(urls, { optimization_lab: true }, () => "file:///o.js"),
    ).toBe(
      "file:///c.js#createCodingModule,file:///a.js#createArenaModule,file:///p.js#createPetModule," +
        "file:///o.js#createOptimizationLabModule",
    );
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/desktop/src/main/capability-modules-env.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现**

```ts
// packages/desktop/src/main/capability-modules-env.ts
/**
 * Composes CODE_SHELL_CAPABILITY_MODULES for the Desktop agent worker. Called at
 * every worker spawn, so toggling a module's feature flag takes effect on the
 * next spawn. A flag-gated module is resolved only when enabled, so an absent
 * optional package cannot break workers that do not load it.
 */
import {
  SettingsManager,
  isFeatureEnabled,
  type FeatureFlagOverrides,
} from "@cjhyy/code-shell-core/extension";

export interface CoreCapabilityModuleUrls {
  readonly coding: string;
  readonly arena: string;
  readonly pet: string;
}

export function composeCapabilityModulesEnv(
  urls: CoreCapabilityModuleUrls,
  flags: FeatureFlagOverrides,
  resolveOptimizationLab: () => string,
): string {
  const entries = [
    `${urls.coding}#createCodingModule`,
    `${urls.arena}#createArenaModule`,
    `${urls.pet}#createPetModule`,
  ];
  if (isFeatureEnabled(flags, "optimization_lab")) {
    entries.push(`${resolveOptimizationLab()}#createOptimizationLabModule`);
  }
  return entries.join(",");
}

/** Same read as main/index.ts featureFlags(): user-scope settings only. */
export function readUserFeatureFlags(cwd: string): FeatureFlagOverrides {
  const settings = new SettingsManager(cwd, "full").getForScope("user") as {
    featureFlags?: FeatureFlagOverrides;
  };
  return settings.featureFlags ?? {};
}
```

- [ ] **Step 4: 接入 `agent-bridge.ts`**：顶部 import 区加：

```ts
import { composeCapabilityModulesEnv, readUserFeatureFlags } from "./capability-modules-env.js";
```

把 `buildEnv` 中的 `CODE_SHELL_CAPABILITY_MODULES` 改为：

```ts
        CODE_SHELL_CAPABILITY_MODULES: composeCapabilityModulesEnv(
          { coding: codingModule, arena: arenaCapabilityModule, pet: petCapabilityModule },
          readUserFeatureFlags(resolveNoRepoCwd()),
          () => import.meta.resolve("@cjhyy/code-shell-capability-optimization-lab/capability"),
        ),
```

- [ ] **Step 5: 验证**

```bash
bun test packages/desktop/src/main/capability-modules-env.test.ts tests/architecture-budgets.test.ts
bun run --filter '@cjhyy/code-shell-desktop' typecheck
```

Expected: PASS；typecheck 无错误。如果 `architecture-budgets` 对 `agent-bridge.ts` 有行数预算并因此失败：本改动净增约 2 行，按该测试的惯例调高预算并注明原因。

- [ ] **Step 6: 提交**

```bash
./node_modules/.bin/prettier --write packages/desktop/src/main/capability-modules-env.ts packages/desktop/src/main/capability-modules-env.test.ts packages/desktop/src/main/agent-bridge.ts
git add packages/desktop/src/main/capability-modules-env.ts packages/desktop/src/main/capability-modules-env.test.ts packages/desktop/src/main/agent-bridge.ts
git commit -m "feat(desktop): load the optimization lab module behind its feature flag"
```

---

## Task 9：稳定序列化与判定策略常量

**Files:**

- Create: `packages/optimization-lab/src/contracts/canonical-json.ts`
- Create: `packages/optimization-lab/src/contracts/verdict-policy.ts`
- Test: `packages/optimization-lab/src/contracts/canonical-json.test.ts`、`verdict-policy.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/optimization-lab/src/contracts/canonical-json.test.ts
import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "./canonical-json.js";

describe("canonicalJson", () => {
  test("is independent of key insertion order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("preserves array order and drops undefined fields", () => {
    expect(canonicalJson({ list: [2, 1], gone: undefined })).toBe('{"list":[2,1]}');
  });

  test("hashes equal values to the same sha256", () => {
    expect(sha256Hex(canonicalJson({ x: 1, y: 2 }))).toBe(sha256Hex(canonicalJson({ y: 2, x: 1 })));
    expect(sha256Hex("")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

```ts
// packages/optimization-lab/src/contracts/verdict-policy.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VERDICT_POLICY, VERDICT_POLICY_SUITE_VERSION } from "./verdict-policy.js";

describe("verdict policy", () => {
  test("matches the eval harness contract it was copied from", () => {
    const cases = JSON.parse(
      readFileSync(new URL("../../../../evals/harness/cases.json", import.meta.url), "utf8"),
    );
    // If this fails, the harness contract changed: re-copy verdictPolicy and
    // suiteVersion instead of loosening the test.
    expect(VERDICT_POLICY).toEqual(cases.verdictPolicy);
    expect(VERDICT_POLICY_SUITE_VERSION).toBe(cases.suiteVersion);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/optimization-lab/src/contracts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现**

```ts
// packages/optimization-lab/src/contracts/canonical-json.ts
import { createHash } from "node:crypto";

/** JSON with object keys sorted and undefined fields dropped, for stable hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}
```

```ts
// packages/optimization-lab/src/contracts/verdict-policy.ts
/**
 * Verdict vocabulary copied from evals/harness/cases.json so lab reports and the
 * engineering harness share one contract. The drift test compares both; the
 * harness runner itself is not a product SDK and is never imported.
 */
export const VERDICT_POLICY_SUITE_VERSION = "2026-09-12.3";

export const VERDICT_POLICY = {
  criterionVerdicts: ["passed", "failed", "inconclusive", "not-applicable"],
  hardAndSemanticIndependent: true,
  hardFailureCannotBeOverriddenBySemanticScore: true,
  missingEvidenceVerdict: "inconclusive",
  executionReasons: ["completed", "cancelled", "timeout", "provider-error", "environment-error"],
  executionStatuses: ["passed", "failed", "inconclusive", "skipped"],
  semanticStatuses: ["passed", "failed", "not_evaluated", "not_applicable"],
  reportEvidenceLevels: ["packaged_live_llm", "repository_regression", "catalogue"],
  hardAssertionValue: "passed: true | false | null (unknown)",
} as const;
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test packages/optimization-lab/src/contracts`
Expected: 4 pass。

- [ ] **Step 5: 提交**

```bash
./node_modules/.bin/prettier --write packages/optimization-lab/src/contracts
git add packages/optimization-lab/src/contracts
git commit -m "feat(optimization-lab): add canonical hashing and verdict policy contract"
```

---

## Task 10：样本 schema 与数据集校验

**Files:**

- Create: `packages/optimization-lab/src/contracts/eval-case.ts`
- Create: `packages/optimization-lab/src/contracts/dataset.ts`（本 Task 只写 `validateDataset`）
- Test: `packages/optimization-lab/src/contracts/dataset.test.ts`

方案 §6.2 的字段在这里落地。首期只有“一类任务”，所以 `taskFamily` 放在数据集层，不放在每个样本上。硬断言只提供确定性检查：`contains`、`not_contains`、`json_field_equals`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/optimization-lab/src/contracts/dataset.test.ts
import { describe, expect, test } from "bun:test";
import { validateDataset } from "./dataset.js";

function evalCase(
  id: string,
  split: "dev" | "holdout",
  group = id,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    version: 1,
    sourceGroupId: group,
    provenance: "synthetic",
    caseRole: "target_failure",
    split,
    input: `Summarize source ${id}`,
    hardAssertions: [{ id: "cites", kind: "contains", value: "[S1]" }],
    readiness: "runnable",
    ...overrides,
  };
}

function dataset(cases: unknown[]) {
  return { schemaVersion: 1, title: "Report sourcing", taskFamily: "report-sourcing", cases };
}

const healthy = () =>
  dataset([
    evalCase("d1", "dev"),
    evalCase("d2", "dev", "d2", { caseRole: "regression" }),
    evalCase("h1", "holdout"),
    evalCase("h2", "holdout"),
    evalCase("h3", "holdout"),
  ]);

const codes = (result: ReturnType<typeof validateDataset>) =>
  result.issues.map((issue) => issue.code).sort();

describe("validateDataset", () => {
  test("accepts a healthy dataset and summarizes it", () => {
    const result = validateDataset(healthy());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.summary).toEqual({
      dev: 2,
      holdout: 3,
      runnableDev: 2,
      runnableHoldout: 3,
      sourceGroups: 5,
    });
  });

  test("reports schema errors with their path", () => {
    const result = validateDataset(dataset([{ id: "BAD ID" }]));
    expect(result.ok).toBe(false);
    expect(result.issues.every((issue) => issue.code === "schema")).toBe(true);
    expect(result.issues[0]!.message).toContain("cases.0");
  });

  test("rejects duplicate ids and duplicate inputs", () => {
    const input = dataset([
      evalCase("d1", "dev"),
      evalCase("d1", "dev", "g2", { input: "other" }),
      evalCase("d3", "dev", "g3", { input: "Summarize source d1" }),
      evalCase("h1", "holdout"),
    ]);
    expect(codes(validateDataset(input))).toEqual(
      expect.arrayContaining(["duplicate_case_id", "duplicate_input"]),
    );
  });

  test("rejects a source group that appears in both splits", () => {
    const input = dataset([evalCase("d1", "dev", "shared"), evalCase("h1", "holdout", "shared")]);
    expect(codes(validateDataset(input))).toContain("source_group_split_leak");
  });

  test("rejects runnable cases without criteria or with missing evidence", () => {
    const input = dataset([
      evalCase("d1", "dev", "d1", { hardAssertions: [], rubric: [] }),
      evalCase("d2", "dev", "d2", { missingEvidence: ["tool response not recorded"] }),
      evalCase("h1", "holdout"),
    ]);
    expect(codes(validateDataset(input))).toEqual(
      expect.arrayContaining(["runnable_without_criteria", "runnable_with_missing_evidence"]),
    );
  });

  test("requires at least one runnable case per split", () => {
    const input = dataset([
      evalCase("d1", "dev"),
      evalCase("h1", "holdout", "h1", { readiness: "analysis_only" }),
    ]);
    const result = validateDataset(input);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("no_runnable_holdout");
  });

  test("warns, without failing, when evidence can only be exploratory", () => {
    const input = dataset([evalCase("d1", "dev"), evalCase("h1", "holdout")]);
    const result = validateDataset(input);
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual(["exploratory_only", "no_regression_cases"]);
    expect(result.issues.every((issue) => issue.level === "warning")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/optimization-lab/src/contracts/dataset.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 schema**

```ts
// packages/optimization-lab/src/contracts/eval-case.ts
import { z } from "zod";

export const MAX_CASE_TEXT_BYTES = 64 * 1024;

const boundedText = (max = MAX_CASE_TEXT_BYTES) =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= max, `exceeds ${max} bytes`);
const shortId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export const HardAssertionSchema = z.discriminatedUnion("kind", [
  z
    .object({ id: shortId, kind: z.literal("contains"), value: z.string().min(1).max(4096) })
    .strict(),
  z
    .object({ id: shortId, kind: z.literal("not_contains"), value: z.string().min(1).max(4096) })
    .strict(),
  z
    .object({
      id: shortId,
      kind: z.literal("json_field_equals"),
      path: z.array(z.string().min(1)).min(1).max(8),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })
    .strict(),
]);

export const RubricItemSchema = z
  .object({ id: shortId, text: z.string().min(1).max(2000), requiresHumanGrading: z.boolean() })
  .strict();

export const EvalCaseSchema = z
  .object({
    id: shortId,
    version: z.number().int().positive(),
    sourceGroupId: z.string().min(1).max(128),
    provenance: z.enum(["real", "synthetic"]),
    caseRole: z.enum(["target_failure", "regression"]),
    split: z.enum(["dev", "holdout"]),
    input: boundedText().refine((value) => value.length > 0, "must not be empty"),
    fixtureRefs: z.array(z.string().min(1).max(256)).max(32).default([]),
    expected: boundedText().optional(),
    rubric: z.array(RubricItemSchema).max(16).default([]),
    hardAssertions: z.array(HardAssertionSchema).max(16).default([]),
    readiness: z.enum(["analysis_only", "runnable"]),
    missingEvidence: z.array(z.string().min(1).max(500)).max(32).default([]),
  })
  .strict();

export const DatasetInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(200),
    taskFamily: z.string().min(1).max(128),
    cases: z.array(EvalCaseSchema).min(1).max(200),
  })
  .strict();

export type HardAssertion = z.infer<typeof HardAssertionSchema>;
export type RubricItem = z.infer<typeof RubricItemSchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type DatasetInput = z.infer<typeof DatasetInputSchema>;
```

- [ ] **Step 4: 实现校验**

```ts
// packages/optimization-lab/src/contracts/dataset.ts
import { canonicalJson, sha256Hex } from "./canonical-json.js";
import { DatasetInputSchema, type DatasetInput } from "./eval-case.js";

export interface DatasetIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  caseId?: string;
}

export interface DatasetSummary {
  dev: number;
  holdout: number;
  runnableDev: number;
  runnableHoldout: number;
  sourceGroups: number;
}

export interface DatasetValidation {
  ok: boolean;
  issues: DatasetIssue[];
  dataset?: DatasetInput;
  summary?: DatasetSummary;
}

/** Holdout source groups below this give an exploratory report, never "verified". */
export const MIN_HOLDOUT_SOURCE_GROUPS = 3;

export function validateDataset(raw: unknown): DatasetValidation {
  const parsed = DatasetInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        level: "error" as const,
        code: "schema",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      })),
    };
  }
  const dataset = parsed.data;
  const issues: DatasetIssue[] = [];
  const error = (code: string, message: string, caseId?: string) =>
    issues.push({ level: "error", code, message, caseId });
  const warning = (code: string, message: string) =>
    issues.push({ level: "warning", code, message });

  const ids = new Set<string>();
  const inputs = new Map<string, string>();
  const groupSplits = new Map<string, Set<string>>();
  for (const item of dataset.cases) {
    if (ids.has(item.id))
      error("duplicate_case_id", `case id ${item.id} appears more than once`, item.id);
    ids.add(item.id);

    const inputHash = sha256Hex(
      canonicalJson({ input: item.input, fixtureRefs: item.fixtureRefs }),
    );
    const first = inputs.get(inputHash);
    if (first !== undefined) {
      error("duplicate_input", `case ${item.id} repeats the input of ${first}`, item.id);
    } else {
      inputs.set(inputHash, item.id);
    }

    const splits = groupSplits.get(item.sourceGroupId) ?? new Set<string>();
    splits.add(item.split);
    groupSplits.set(item.sourceGroupId, splits);

    if (
      item.readiness === "runnable" &&
      item.hardAssertions.length === 0 &&
      item.rubric.length === 0
    ) {
      error(
        "runnable_without_criteria",
        `runnable case ${item.id} has no assertion or rubric`,
        item.id,
      );
    }
    if (item.readiness === "runnable" && item.missingEvidence.length > 0) {
      error(
        "runnable_with_missing_evidence",
        `case ${item.id} lists missing evidence; mark it analysis_only`,
        item.id,
      );
    }
  }
  for (const [group, splits] of groupSplits) {
    if (splits.size > 1)
      error("source_group_split_leak", `source group ${group} appears in both dev and holdout`);
  }

  const dev = dataset.cases.filter((item) => item.split === "dev");
  const holdout = dataset.cases.filter((item) => item.split === "holdout");
  const runnableDev = dev.filter((item) => item.readiness === "runnable").length;
  const runnableHoldout = holdout.filter((item) => item.readiness === "runnable").length;
  if (runnableDev === 0) error("no_runnable_dev", "the dev split has no runnable case");
  if (runnableHoldout === 0) error("no_runnable_holdout", "the holdout split has no runnable case");

  const holdoutGroups = new Set(
    holdout.filter((item) => item.readiness === "runnable").map((item) => item.sourceGroupId),
  );
  if (runnableHoldout > 0 && holdoutGroups.size < MIN_HOLDOUT_SOURCE_GROUPS) {
    warning(
      "exploratory_only",
      `holdout has ${holdoutGroups.size} independent source group(s); results can only be exploratory`,
    );
  }
  if (!dataset.cases.some((item) => item.caseRole === "regression")) {
    warning("no_regression_cases", "no regression case covers tasks that already succeed");
  }

  return {
    ok: !issues.some((issue) => issue.level === "error"),
    issues,
    dataset,
    summary: {
      dev: dev.length,
      holdout: holdout.length,
      runnableDev,
      runnableHoldout,
      sourceGroups: groupSplits.size,
    },
  };
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `bun test packages/optimization-lab/src/contracts/dataset.test.ts`
Expected: 7 pass。

- [ ] **Step 6: 提交**

```bash
./node_modules/.bin/prettier --write packages/optimization-lab/src/contracts
git add packages/optimization-lab/src/contracts
git commit -m "feat(optimization-lab): validate evaluation datasets"
```

---

## Task 11：冻结数据集、存储路径与 queries

**Files:**

- Create: `packages/optimization-lab/src/store-paths.ts`
- Modify: `packages/optimization-lab/src/contracts/dataset.ts`（新增 `freezeDataset`）
- Create: `packages/optimization-lab/src/queries.ts`
- Modify: `packages/optimization-lab/src/module.ts`、`src/index.ts`、`src/index.exports.test.ts`
- Test: `packages/optimization-lab/src/store-paths.test.ts`、`src/queries.test.ts`

冻结后的清单不可变：同一内容永远得到同一 `datasetHash`，已存在的清单不覆写。写入用 Task 2 导出的 `mutateJsonFile`（锁内重读 + 临时文件 rename）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/optimization-lab/src/store-paths.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labRoot, projectKey } from "./store-paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("store paths", () => {
  test("keeps lab data under the isolated CodeShell home", () => {
    const cwd = mkdtempSync(join(tmpdir(), "optlab-paths-"));
    roots.push(cwd);
    expect(process.env.CODE_SHELL_HOME).toBeTruthy();
    expect(labRoot(cwd).startsWith(join(process.env.CODE_SHELL_HOME!, "optimization-lab"))).toBe(
      true,
    );
  });

  test("gives a symlinked project the same key as its real path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "optlab-paths-"));
    roots.push(cwd);
    const alias = `${cwd}-alias`;
    symlinkSync(cwd, alias);
    roots.push(alias);
    expect(projectKey(alias)).toBe(projectKey(cwd));
    expect(projectKey(cwd)).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

```ts
// packages/optimization-lab/src/queries.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPTIMIZATION_LAB_QUERIES } from "./queries.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "optlab-queries-"));
  roots.push(cwd);
  return cwd;
}

const dataset = {
  schemaVersion: 1,
  title: "Report sourcing",
  taskFamily: "report-sourcing",
  cases: ["d1", "h1", "h2", "h3"].map((id) => ({
    id,
    version: 1,
    sourceGroupId: id,
    provenance: "synthetic",
    caseRole: id === "d1" ? "regression" : "target_failure",
    split: id.startsWith("d") ? "dev" : "holdout",
    input: `Summarize source ${id}`,
    hardAssertions: [{ id: "cites", kind: "contains", value: "[S1]" }],
    readiness: "runnable",
  })),
};

const validate = OPTIMIZATION_LAB_QUERIES.optimization_lab_validate_dataset!;
const freeze = OPTIMIZATION_LAB_QUERIES.optimization_lab_freeze_dataset!;

describe("optimization lab queries", () => {
  test("validate never writes to disk", async () => {
    const result = (await validate({ type: "optimization_lab_validate_dataset", dataset })) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
  });

  test("freeze writes one immutable manifest and is idempotent", async () => {
    const cwd = project();
    const first = (await freeze({ type: "optimization_lab_freeze_dataset", cwd, dataset })) as {
      ok: true;
      created: boolean;
      path: string;
      manifest: { datasetHash: string; frozenAt: string; cases: { id: string }[] };
    };
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(first.manifest.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.path.endsWith(join("datasets", first.manifest.datasetHash, "manifest.json"))).toBe(
      true,
    );
    expect(existsSync(first.path)).toBe(true);
    expect(first.manifest.cases.map((item) => item.id)).toEqual(["d1", "h1", "h2", "h3"]);

    const reordered = { ...dataset, cases: [...dataset.cases].reverse() };
    const second = (await freeze({
      type: "optimization_lab_freeze_dataset",
      cwd,
      dataset: reordered,
    })) as typeof first;
    expect(second.created).toBe(false);
    expect(second.manifest.datasetHash).toBe(first.manifest.datasetHash);
    expect(second.manifest.frozenAt).toBe(first.manifest.frozenAt);
    expect(JSON.parse(readFileSync(first.path, "utf8")).frozenAt).toBe(first.manifest.frozenAt);
  });

  test("freeze refuses an invalid dataset without writing", async () => {
    const cwd = project();
    const result = (await freeze({
      type: "optimization_lab_freeze_dataset",
      cwd,
      dataset: { ...dataset, cases: [] },
    })) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  test("freeze requires a cwd", async () => {
    await expect(
      Promise.resolve().then(() => freeze({ type: "optimization_lab_freeze_dataset", dataset })),
    ).rejects.toThrow("cwd is required");
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/optimization-lab/src/store-paths.test.ts packages/optimization-lab/src/queries.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现存储路径**

```ts
// packages/optimization-lab/src/store-paths.ts
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core/extension";
import { sha256Hex } from "./contracts/canonical-json.js";

/** Stable per-project key; symlinked paths to one project share it. */
export function projectKey(cwd: string): string {
  return sha256Hex(realpathSync(cwd)).slice(0, 16);
}

/** Long-lived lab directory for a project. Never a temp or task directory. */
export function labRoot(cwd: string): string {
  return join(codeShellHome(), "optimization-lab", projectKey(cwd));
}
```

- [ ] **Step 4: 实现冻结**：在 `contracts/dataset.ts` 顶部 import 区补上：

```ts
import { join } from "node:path";
import { mutateJsonFile } from "@cjhyy/code-shell-core/extension";
import type { EvalCase } from "./eval-case.js";
import { VERDICT_POLICY_SUITE_VERSION } from "./verdict-policy.js";
```

文件末尾追加：

```ts
export interface DatasetManifest {
  schemaVersion: 1;
  datasetHash: string;
  frozenAt: string;
  title: string;
  taskFamily: string;
  verdictPolicySuiteVersion: string;
  cases: EvalCase[];
  caseHashes: Record<string, string>;
  summary: DatasetSummary;
}

export type FreezeResult =
  | { ok: true; created: boolean; path: string; manifest: DatasetManifest }
  | { ok: false; issues: DatasetIssue[] };

/**
 * Freeze a validated dataset into <labRoot>/datasets/<hash>/manifest.json. The
 * hash covers content only (cases sorted by id), so re-freezing the same cases
 * returns the existing manifest untouched. No model call happens here.
 */
export function freezeDataset(
  raw: unknown,
  labRootDir: string,
  now: () => Date = () => new Date(),
): FreezeResult {
  const validation = validateDataset(raw);
  if (!validation.ok || !validation.dataset || !validation.summary) {
    return { ok: false, issues: validation.issues };
  }
  const { title, taskFamily } = validation.dataset;
  const cases = [...validation.dataset.cases].sort((a, b) => a.id.localeCompare(b.id));
  const datasetHash = sha256Hex(
    canonicalJson({
      schemaVersion: 1,
      title,
      taskFamily,
      verdictPolicySuiteVersion: VERDICT_POLICY_SUITE_VERSION,
      cases,
    }),
  );
  const caseHashes = Object.fromEntries(
    cases.map((item) => [item.id, sha256Hex(canonicalJson(item))]),
  );
  const path = join(labRootDir, "datasets", datasetHash, "manifest.json");
  const summary = validation.summary;

  const outcome = mutateJsonFile<
    DatasetManifest | undefined,
    { created: boolean; manifest: DatasetManifest }
  >(path, {
    parse: (text) => (text === undefined ? undefined : (JSON.parse(text) as DatasetManifest)),
    serialize: (value) => `${JSON.stringify(value, null, 2)}\n`,
    mutation: (current) => {
      if (current) {
        if (current.datasetHash !== datasetHash) {
          throw new Error(`dataset manifest at ${path} does not match its directory hash`);
        }
        return { result: { created: false, manifest: current } };
      }
      const manifest: DatasetManifest = {
        schemaVersion: 1,
        datasetHash,
        frozenAt: now().toISOString(),
        title,
        taskFamily,
        verdictPolicySuiteVersion: VERDICT_POLICY_SUITE_VERSION,
        cases,
        caseHashes,
        summary,
      };
      return { value: manifest, result: { created: true, manifest } };
    },
  });
  if (!outcome) throw new Error(`freezing dataset ${datasetHash} produced no result`);
  return { ok: true, path, ...outcome };
}
```

- [ ] **Step 5: 实现 queries 并挂到模块**

```ts
// packages/optimization-lab/src/queries.ts
import type { ExtensionQueryHandler } from "@cjhyy/code-shell-core/extension";
import { freezeDataset, validateDataset } from "./contracts/dataset.js";
import { labRoot } from "./store-paths.js";

function requireString(params: Readonly<Record<string, unknown>>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`optimization_lab: ${key} is required`);
  }
  return value;
}

export const OPTIMIZATION_LAB_QUERIES: Readonly<Record<string, ExtensionQueryHandler>> = {
  optimization_lab_validate_dataset: (params) => validateDataset(params.dataset),
  optimization_lab_freeze_dataset: (params) =>
    freezeDataset(params.dataset, labRoot(requireString(params, "cwd"))),
};
```

`module.ts` 改为：

```ts
import type { AgentModule } from "@cjhyy/code-shell-core/extension";
import { OPTIMIZATION_LAB_QUERIES } from "./queries.js";

export const OPTIMIZATION_LAB_MODULE_ID = "optimization-lab";

/** Optimization Lab as an AgentModule. Every query is namespaced optimization_lab_*. */
export function createOptimizationLabModule(): AgentModule {
  return { id: OPTIMIZATION_LAB_MODULE_ID, protocol: { queries: OPTIMIZATION_LAB_QUERIES } };
}
```

`src/index.ts` 改为：

```ts
export { createOptimizationLabModule } from "./module.js";
export { freezeDataset, validateDataset } from "./contracts/dataset.js";
export type {
  DatasetIssue,
  DatasetManifest,
  DatasetSummary,
  DatasetValidation,
  FreezeResult,
} from "./contracts/dataset.js";
export type { DatasetInput, EvalCase, HardAssertion, RubricItem } from "./contracts/eval-case.js";
export { VERDICT_POLICY, VERDICT_POLICY_SUITE_VERSION } from "./contracts/verdict-policy.js";
```

`src/index.exports.test.ts` 的第一个用例中补一条根入口断言：

```ts
expect(Object.keys(rootApi).sort()).toEqual([
  "VERDICT_POLICY",
  "VERDICT_POLICY_SUITE_VERSION",
  "createOptimizationLabModule",
  "freezeDataset",
  "validateDataset",
]);
```

- [ ] **Step 6: 运行，确认通过**

```bash
bun test packages/optimization-lab tests/optimization-lab-composition.test.ts
bun run --filter '@cjhyy/code-shell-capability-optimization-lab' typecheck
./node_modules/.bin/eslint packages/optimization-lab/src
```

Expected: 全部 PASS；typecheck、eslint 无错误。

- [ ] **Step 7: 提交**

```bash
./node_modules/.bin/prettier --write packages/optimization-lab/src
git add packages/optimization-lab/src
git commit -m "feat(optimization-lab): freeze datasets and expose dataset queries"
```

---

## Task 12：整体验证与交付

- [ ] **Step 1: 全量门禁**

```bash
bun run typecheck
bun test packages tests
bun scripts/verify-release-versions.ts
```

Expected: 全部通过。有失败时先在 `main` 的 worktree 上复现，确认是否本分支引入。

- [ ] **Step 2: Desktop 打包验证**

Run: `bun run --cwd packages/desktop predist`
Expected: 结尾输出 `materialized Link + core + coding + Arena + Pet + Optimization Lab into node_modules`，且 `verifyMaterializedCapabilities` 的 import 不报错。

- [ ] **Step 3: 开关关闭时的真机检查**：用默认设置启动 Desktop（`bun run dev:desktop`），新建会话并发一条消息。Expected：会话正常；`~/.code-shell/optimization-lab` 不存在。

- [ ] **Step 4: 开关打开时的真机检查**：在用户设置 `~/.code-shell/settings.json` 中加 `"featureFlags": { "optimization_lab": true }`，重启 Desktop 并发一条消息拉起 worker。在 Desktop 开发者工具的控制台执行：

```js
await window.codeshell.rpc?.("agent/query", {
  type: "optimization_lab_validate_dataset",
  dataset: {},
});
```

如果 `window.codeshell` 没有暴露通用 `rpc`，改为在 main 进程日志里确认 worker 启动参数中的 `CODE_SHELL_CAPABILITY_MODULES` 含 `#createOptimizationLabModule`。Expected：返回 `{ type, data: { ok: false, issues: [...] } }`，或日志中能看到该模块。检查完把设置改回。

- [ ] **Step 5: 更新方案状态**：在 `docs/todo/optimization-lab-mvp.md` 顶部状态行注明“计划 A（地基）已实施”，并附提交范围；`TODO.md` 对应条目同步。

- [ ] **Step 6: 集成**：按 CODESHELL.md 分支规则，刷新 `origin/main`、在任务分支上解决冲突、重跑 Step 1，然后快进或普通合并进 `main`。推送前需负责人确认。

- [ ] **Step 7: 写计划 B**：以本计划落地的类型（`DatasetManifest`、`EvalCase`、`labRoot`）为基础，写 `docs/superpowers/plans/<date>-optimization-lab-engine.md`。

---

## 自查记录

- **方案覆盖（计划 A 范围）**：§5.1 内置能力包、feature flag、私有不发布、只接入 Desktop → Task 3、4、6、7、8；§5.2 P1a 三项 Core 导出 → Task 1、2；§6.2 样本字段、同源不跨集合 → Task 10；§9 长期目录、不可变 artifacts → Task 11；§11 沿用 `verdictPolicy` → Task 9；§13 P0 通过标准（6–12 个样本可校验、切分、生成 dataset hash，无模型调用）→ Task 10、11。
- **明确留给计划 B/C 的方案条目**：§7、§8、§10、§11 报告与判分、§12.1、§14 其余 `[P1a]` 项。
- **命名一致性**：`readSkillSnapshot` / `SkillSnapshot`、`createOptimizationLabModule`、`OPTIMIZATION_LAB_QUERIES`、`labRoot` / `projectKey`、`validateDataset` / `freezeDataset` / `DatasetManifest`，在各 Task 中拼写一致。
- **已知不确定点（执行时核对）**：项目级 Skill 在临时目录中能否被扫描到（Task 1 Step 2 已给出处理办法）；`agent-bridge.ts` 是否有行数预算（Task 8 Step 5）；Desktop 控制台是否暴露通用 `rpc`（Task 12 Step 4 已给替代检查）。
