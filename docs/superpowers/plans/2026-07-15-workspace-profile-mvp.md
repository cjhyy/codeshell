# WorkspaceProfile（数字人）MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 workspace 装上可激活/可切换/可关闭的"数字人"（WorkspaceProfile）：批量 force-enable 能力 + 主指令注入系统提示 + 可移植记忆层，含最小 desktop UI。

**Architecture:** core 内新增 `packages/core/src/profile/`（harness 元机制，与 plugins/presets 同类，不走 CapabilityModule 缝）。激活 = 原子重写项目 settings 的单一 `profile` 子树；能力折叠经单一咽喉 `effectiveProjectOverrides()`（用户手写 `capabilityOverrides` 按 key 赢过 `profile.overrides`）；主指令作为 composer 独立 section 排在 preset 之后（CLAUDE.md 指令走 user-context 消息天然更靠后 → 优先级 CLAUDE.md > mainInstruction > preset 自动成立）；记忆第三层复用 `MemoryManager` 的 `baseDir`。解析统一走 `resolveActiveWorkspaceProfile({sessionProfile?, cwd, settings})`——本期 `sessionProfile` 恒为 undefined，为后续 per-session 绑定预留。

**Tech Stack:** TypeScript + bun test（不是 vitest/jest）、zod、Electron desktop（shadcn/ui + Tailwind）。设计稿：`docs/superpowers/specs/2026-07-15-workspace-profile-design.md`。

**必读约定（CODESHELL.md）：** bun workspace（不用 npm/yarn/pnpm）；conventional commits；desktop 有自己的 typecheck/build（`cd packages/desktop && bun run typecheck`），根目录检查不覆盖它。**注意**：根 `bun run typecheck` 当前有 31 个**预先存在**的错误（oauth.test.ts / mcp-manager.test.ts / subagent-spawner.test.ts 等，是 undici-types 环境问题）——它们不是你造成的，验收标准是"不新增错误"。

**关键命名警告：** 代码库里已有三个"profile"：pet 的 `RunBehaviorProfile`（行为剖面，engine.ts 内局部变量名 `profile`，见 engine.ts:1917）、settings 的 `agent.userProfile`（用户画像字符串）、本 feature 的 `WorkspaceProfile`。在 engine 内新代码一律用 `workspaceProfile` 变量名，绝不要覆盖或混用局部变量 `profile`。

---

### Task 1: WorkspaceProfile schema（types.ts）

**Files:**
- Create: `packages/core/src/profile/types.ts`
- Test: `packages/core/src/profile/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/profile/types.test.ts
import { describe, expect, test } from "bun:test";
import { WorkspaceProfileSchema } from "./types.js";

describe("WorkspaceProfile schema", () => {
  test("accepts a minimal valid profile and fills defaults", () => {
    const p = WorkspaceProfileSchema.parse({
      name: "ui-designer",
      label: "UI 设计师",
      basePreset: "general",
    });
    expect(p.plugins).toEqual([]);
    expect(p.skills).toEqual([]);
    expect(p.mcp).toEqual([]);
    expect(p.agents).toEqual([]);
    expect(p.portableMemory).toBe(false);
  });

  test("accepts the full shape", () => {
    const p = WorkspaceProfileSchema.parse({
      name: "seedance",
      label: "Seedance 分镜制片人",
      description: "三阶段调度",
      basePreset: "general",
      plugins: ["seedance-pack"],
      skills: ["storyboard"],
      mcp: ["figma"],
      agents: ["director"],
      mainInstruction: "你是制片人，按 导演→服化道→分镜 三阶段调度。",
      portableMemory: true,
      version: "0.1.0",
    });
    expect(p.mainInstruction).toContain("制片人");
  });

  test("rejects illegal names (path traversal / uppercase / empty)", () => {
    for (const name of ["", "../evil", "UPPER", "has space", "a/b"]) {
      expect(() =>
        WorkspaceProfileSchema.parse({ name, label: "x", basePreset: "general" }),
      ).toThrow();
    }
  });

  test("rejects missing basePreset", () => {
    expect(() => WorkspaceProfileSchema.parse({ name: "x", label: "x" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/profile/types.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/profile/types.ts
/**
 * WorkspaceProfile（数字人）— harness 元机制的数据定义。
 * 引用现有窄 AgentPreset，不修改它；plugins/skills/mcp/agents 在激活时
 * 展开为 capabilityOverrides 形状的 force-enable 快照（见 activation.ts）。
 * 设计稿：docs/superpowers/specs/2026-07-15-workspace-profile-design.md
 */
import { z } from "zod";

/** 目录名即机器标识：小写字母/数字开头，可含 - _，防路径逃逸。 */
export const WORKSPACE_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const WorkspaceProfileSchema = z.object({
  name: z.string().regex(WORKSPACE_PROFILE_NAME_RE),
  label: z.string().min(1),
  description: z.string().optional(),
  /** 引用现有 AgentPreset 名（如 "general"）；不在 schema 层校验存在性，解析时才校验。 */
  basePreset: z.string().min(1),
  plugins: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  mcp: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  /** 数字人主指令，注入系统提示（优先级低于本地 CLAUDE.md，高于 preset sections）。 */
  mainInstruction: z.string().optional(),
  /** true → 挂载 profiles/<name>/ 为第二记忆层（跟数字人走）。 */
  portableMemory: z.boolean().default(false),
  version: z.string().optional(),
});

export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/profile/types.test.ts`
Expected: PASS（4 pass）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/profile/types.ts packages/core/src/profile/types.test.ts
git commit -m "feat(profile): WorkspaceProfile schema"
```

---

### Task 2: 全局 profile 库（store.ts）

**Files:**
- Create: `packages/core/src/profile/store.ts`
- Test: `packages/core/src/profile/store.test.ts`

库路径：`codeShellHome()/profiles/<name>/profile.json`。`codeShellHome()`（`packages/core/src/session/session-manager.ts:386`）已按 `CODE_SHELL_HOME` env 解析 → identity dataRoot 下 per-user worker 自动各有各的库，测试也用这个 env 隔离。

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/profile/store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listWorkspaceProfiles,
  readWorkspaceProfile,
  saveWorkspaceProfile,
  workspaceProfileDir,
  workspaceProfilesRoot,
} from "./store.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-profile-store-"));
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("workspace profile store", () => {
  test("save then read round-trips and paths derive from CODE_SHELL_HOME", () => {
    saveWorkspaceProfile({
      name: "seedance",
      label: "Seedance",
      basePreset: "general",
      plugins: ["seedance-pack"],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: true,
    });
    expect(workspaceProfilesRoot()).toBe(join(home, "profiles"));
    expect(workspaceProfileDir("seedance")).toBe(join(home, "profiles", "seedance"));
    const read = readWorkspaceProfile("seedance");
    expect(read?.label).toBe("Seedance");
    expect(read?.portableMemory).toBe(true);
  });

  test("read returns undefined for a missing profile", () => {
    expect(readWorkspaceProfile("nope")).toBeUndefined();
  });

  test("read throws a wrapped error for invalid JSON content", () => {
    mkdirSync(join(home, "profiles", "bad"), { recursive: true });
    writeFileSync(join(home, "profiles", "bad", "profile.json"), "not json");
    expect(() => readWorkspaceProfile("bad")).toThrow(/bad/);
  });

  test("read rejects names failing the name regex without touching disk", () => {
    expect(readWorkspaceProfile("../evil")).toBeUndefined();
  });

  test("list returns valid profiles sorted by name and skips broken ones", () => {
    saveWorkspaceProfile({ name: "b-two", label: "B", basePreset: "general", plugins: [], skills: [], mcp: [], agents: [], portableMemory: false });
    saveWorkspaceProfile({ name: "a-one", label: "A", basePreset: "general", plugins: [], skills: [], mcp: [], agents: [], portableMemory: false });
    mkdirSync(join(home, "profiles", "broken"), { recursive: true });
    writeFileSync(join(home, "profiles", "broken", "profile.json"), "{}");
    expect(listWorkspaceProfiles().map((p) => p.name)).toEqual(["a-one", "b-two"]);
  });

  test("list returns [] when the library directory does not exist", () => {
    expect(listWorkspaceProfiles()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/profile/store.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/profile/store.ts
/**
 * 全局数字人库：~/.code-shell/profiles/<name>/profile.json。
 * 路径一律经 codeShellHome() 解析（CODE_SHELL_HOME / identity dataRoot 生效）。
 * core 不内置任何领域 profile；样例见 docs/examples/workspace-profile-sample.md。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeShellHome } from "../session/session-manager.js";
import { logger } from "../logging/logger.js";
import { WORKSPACE_PROFILE_NAME_RE, WorkspaceProfileSchema, type WorkspaceProfile } from "./types.js";

export function workspaceProfilesRoot(): string {
  return join(codeShellHome(), "profiles");
}

/** 该数字人的根目录 —— 同时也是它可移植记忆层的 MemoryManager baseDir。 */
export function workspaceProfileDir(name: string): string {
  return join(workspaceProfilesRoot(), name);
}

export function readWorkspaceProfile(name: string): WorkspaceProfile | undefined {
  if (!WORKSPACE_PROFILE_NAME_RE.test(name)) return undefined;
  const path = join(workspaceProfileDir(name), "profile.json");
  if (!existsSync(path)) return undefined;
  try {
    return WorkspaceProfileSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    throw new Error(
      `Invalid workspace profile "${name}" at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function listWorkspaceProfiles(): WorkspaceProfile[] {
  const root = workspaceProfilesRoot();
  if (!existsSync(root)) return [];
  const out: WorkspaceProfile[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const p = readWorkspaceProfile(entry.name);
      if (p) out.push(p);
    } catch (error) {
      logger.warn("profile.library_entry_invalid", {
        cat: "profile",
        name: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 原子写（tmp+rename），与 SettingsManager 的写法一致。 */
export function saveWorkspaceProfile(profile: WorkspaceProfile): void {
  const parsed = WorkspaceProfileSchema.parse(profile);
  const dir = workspaceProfileDir(parsed.name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "profile.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/profile/store.test.ts`
Expected: PASS（6 pass）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/profile/store.ts packages/core/src/profile/store.test.ts
git commit -m "feat(profile): global profile library store"
```

---

### Task 3: settings schema 的 `profile` 子树

**Files:**
- Modify: `packages/core/src/settings/schema.ts`（`capabilityOverrides: CapabilityOverridesSchema` 在第 387 行附近；把新字段加在它旁边）
- Test: `packages/core/src/settings/profile-subtree.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/settings/profile-subtree.test.ts
import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "./schema.js";

describe("settings profile subtree", () => {
  test("accepts a full profile subtree", () => {
    const s = SettingsSchema.parse({
      profile: {
        active: "seedance",
        preset: "general",
        overrides: { plugins: { "seedance-pack": "on" } },
      },
    });
    expect(s.profile?.active).toBe("seedance");
    expect(s.profile?.overrides?.plugins?.["seedance-pack"]).toBe("on");
  });

  test("absent profile subtree stays undefined", () => {
    expect(SettingsSchema.parse({}).profile).toBeUndefined();
  });

  test("rejects a subtree without active", () => {
    expect(() => SettingsSchema.parse({ profile: { preset: "general" } })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/settings/profile-subtree.test.ts`
Expected: FAIL（`profile` 被 strip 或报未知键，取决于 schema strict 配置）

- [ ] **Step 3: Add the field**

在 `packages/core/src/settings/schema.ts` 的 `SettingsSchema` 对象里、`capabilityOverrides: CapabilityOverridesSchema,`（~387 行）后加：

```ts
    /**
     * 由 WorkspaceProfile 激活事务整体拥有的子树（profile/activation.ts）。
     * 激活/切换 = 原子全量重写本子树；关闭 = 删除本子树。
     * `overrides` 是 profile 声明展开的 force-enable 快照，折叠时排在
     * 用户手写 capabilityOverrides 之下（用户按 key 永远赢，见 overlay.ts
     * 的 effectiveProjectOverrides）。只存在于 PROJECT settings。
     */
    profile: z
      .object({
        active: z.string(),
        preset: z.string().optional(),
        overrides: CapabilityOverridesSchema,
      })
      .optional(),
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/settings/`
Expected: 新测试 PASS，现有 settings 测试全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/settings/schema.ts packages/core/src/settings/profile-subtree.test.ts
git commit -m "feat(settings): profile-owned subtree in project settings"
```

---

### Task 4: 激活/切换/关闭事务（activation.ts）

**Files:**
- Create: `packages/core/src/profile/activation.ts`
- Test: `packages/core/src/profile/activation.test.ts`

复用 `SettingsManager.saveProjectSetting(key, value, cwd)`（`settings/manager.ts:443`，已是原子 tmp+rename 写）与 `deleteProjectSetting(key, cwd)`（:462）。**切换 = 再次激活**（全量重写子树天然原子替换旧值）。

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/profile/activation.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import { saveWorkspaceProfile } from "./store.js";
import {
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  profileOverridesFromDefinition,
} from "./activation.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

function projectSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, ".code-shell", "settings.json"), "utf-8"));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-profile-act-"));
  cwd = join(home, "ws");
  mkdirSync(cwd, { recursive: true });
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  saveWorkspaceProfile({
    name: "seedance", label: "Seedance", basePreset: "general",
    plugins: ["seedance-pack"], skills: ["storyboard"], mcp: [], agents: ["director"],
    portableMemory: true,
  });
  saveWorkspaceProfile({
    name: "ui-designer", label: "UI 设计师", basePreset: "general",
    plugins: ["figma-pack"], skills: [], mcp: [], agents: [], portableMemory: false,
  });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("workspace profile activation transaction", () => {
  test("expands declared capabilities into an 'on' override snapshot", () => {
    const ov = profileOverridesFromDefinition({
      name: "x", label: "x", basePreset: "general",
      plugins: ["p1"], skills: ["s1"], mcp: [], agents: ["a1"], portableMemory: false,
    });
    expect(ov).toEqual({
      plugins: { p1: "on" },
      skills: { s1: "on" },
      agents: { a1: "on" },
    });
  });

  test("activate writes the whole profile subtree into project settings", () => {
    const sm = new SettingsManager(cwd, "full");
    activateWorkspaceProfile(sm, "seedance", cwd);
    const s = projectSettings();
    expect(s.profile).toEqual({
      active: "seedance",
      preset: "general",
      overrides: {
        plugins: { "seedance-pack": "on" },
        skills: { storyboard: "on" },
        agents: { director: "on" },
      },
    });
  });

  test("switching replaces the subtree wholesale (old capabilities gone)", () => {
    const sm = new SettingsManager(cwd, "full");
    activateWorkspaceProfile(sm, "seedance", cwd);
    activateWorkspaceProfile(sm, "ui-designer", cwd);
    const s = projectSettings() as { profile: { active: string; overrides: Record<string, unknown> } };
    expect(s.profile.active).toBe("ui-designer");
    expect(s.profile.overrides).toEqual({ plugins: { "figma-pack": "on" } });
  });

  test("deactivate removes the subtree and never touches user capabilityOverrides", () => {
    const sm = new SettingsManager(cwd, "full");
    sm.saveProjectSetting("capabilityOverrides", { skills: { "my-skill": "off" } }, cwd);
    activateWorkspaceProfile(sm, "seedance", cwd);
    deactivateWorkspaceProfile(sm, cwd);
    const s = projectSettings();
    expect(s.profile).toBeUndefined();
    expect(s.capabilityOverrides).toEqual({ skills: { "my-skill": "off" } });
  });

  test("activating an unknown profile throws and leaves settings untouched", () => {
    const sm = new SettingsManager(cwd, "full");
    expect(() => activateWorkspaceProfile(sm, "nope", cwd)).toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/profile/activation.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/profile/activation.ts
/**
 * 激活/切换/关闭事务。原子性来源：整个 `profile` 子树一次
 * saveProjectSetting 写入（内部 tmp+rename）——切换即全量替换，
 * 永远不存在"旧的撤一半、新的写一半"。
 * mainInstruction / portableMemory 不落 settings：settings 只记 active
 * 名字（+ preset/overrides 快照），活字段由 resolve.ts 从库读取。
 */
import type { SettingsManager } from "../settings/manager.js";
import type { CapabilityOverrides } from "../settings/schema.js";
import { readWorkspaceProfile } from "./store.js";
import type { WorkspaceProfile } from "./types.js";

/** settings.profile 子树的形状（与 settings/schema.ts 的 zod 定义一致）。 */
export interface WorkspaceProfileSubtree {
  active: string;
  preset?: string;
  overrides?: CapabilityOverrides;
}

/** 把 profile 声明的能力展开为 force-enable 快照；空 bucket 不落键。 */
export function profileOverridesFromDefinition(p: WorkspaceProfile): CapabilityOverrides {
  const bucket = (names: readonly string[]): Record<string, "on"> | undefined =>
    names.length > 0 ? Object.fromEntries(names.map((n) => [n, "on" as const])) : undefined;
  const plugins = bucket(p.plugins);
  const skills = bucket(p.skills);
  const mcp = bucket(p.mcp);
  const agents = bucket(p.agents);
  return {
    ...(plugins ? { plugins } : {}),
    ...(skills ? { skills } : {}),
    ...(mcp ? { mcp } : {}),
    ...(agents ? { agents } : {}),
  };
}

export function activateWorkspaceProfile(
  sm: SettingsManager,
  name: string,
  cwd: string,
): WorkspaceProfile {
  const profile = readWorkspaceProfile(name);
  if (!profile) {
    throw new Error(`Workspace profile "${name}" not found in the global library`);
  }
  const subtree: WorkspaceProfileSubtree = {
    active: profile.name,
    preset: profile.basePreset,
    overrides: profileOverridesFromDefinition(profile),
  };
  sm.saveProjectSetting("profile", subtree, cwd);
  return profile;
}

export function deactivateWorkspaceProfile(sm: SettingsManager, cwd: string): void {
  sm.deleteProjectSetting("profile", cwd);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/profile/activation.test.ts`
Expected: PASS（5 pass）

注意：若 `saveProjectSetting` 因 dotted-key 语义把 `"profile"` 当路径处理出问题（它内部用 `setDottedSetting`），值本身是对象、键无点号，应当直接落为顶层键；如失败，读 `settings/manager.ts:443-461` 确认行为后修测试或实现，不要改 manager 的通用语义。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/profile/activation.ts packages/core/src/profile/activation.test.ts
git commit -m "feat(profile): atomic activate/switch/deactivate transaction"
```

---

### Task 5: 解析层（resolve.ts，预留 session 级缝）

**Files:**
- Create: `packages/core/src/profile/resolve.ts`
- Test: `packages/core/src/profile/resolve.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/profile/resolve.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import { saveWorkspaceProfile } from "./store.js";
import { activateWorkspaceProfile } from "./activation.js";
import { resolveActiveWorkspaceProfile, workspaceProfilePresetFor } from "./resolve.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-profile-res-"));
  cwd = join(home, "ws");
  mkdirSync(cwd, { recursive: true });
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  saveWorkspaceProfile({
    name: "seedance", label: "Seedance", basePreset: "general",
    plugins: [], skills: [], mcp: [], agents: [],
    mainInstruction: "三阶段调度", portableMemory: true,
  });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("resolveActiveWorkspaceProfile", () => {
  test("resolves the workspace default from project settings", () => {
    const sm = new SettingsManager(cwd, "full");
    activateWorkspaceProfile(sm, "seedance", cwd);
    const p = resolveActiveWorkspaceProfile({ cwd, settings: sm });
    expect(p?.name).toBe("seedance");
    expect(p?.mainInstruction).toBe("三阶段调度");
  });

  test("returns undefined when nothing is active", () => {
    const sm = new SettingsManager(cwd, "full");
    expect(resolveActiveWorkspaceProfile({ cwd, settings: sm })).toBeUndefined();
  });

  test("sessionProfile (future per-session binding) wins over workspace default", () => {
    const sm = new SettingsManager(cwd, "full");
    saveWorkspaceProfile({
      name: "ui-designer", label: "UI", basePreset: "general",
      plugins: [], skills: [], mcp: [], agents: [], portableMemory: false,
    });
    activateWorkspaceProfile(sm, "seedance", cwd);
    const p = resolveActiveWorkspaceProfile({ sessionProfile: "ui-designer", cwd, settings: sm });
    expect(p?.name).toBe("ui-designer");
  });

  test("active name pointing at a deleted library entry degrades to undefined", () => {
    const sm = new SettingsManager(cwd, "full");
    activateWorkspaceProfile(sm, "seedance", cwd);
    rmSync(join(home, "profiles", "seedance"), { recursive: true, force: true });
    expect(resolveActiveWorkspaceProfile({ cwd, settings: sm })).toBeUndefined();
  });

  test("workspaceProfilePresetFor returns the snapshot preset", () => {
    const sm = new SettingsManager(cwd, "full");
    activateWorkspaceProfile(sm, "seedance", cwd);
    expect(workspaceProfilePresetFor(sm, cwd)).toBe("general");
    expect(workspaceProfilePresetFor(sm, join(home, "elsewhere"))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/profile/resolve.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/profile/resolve.ts
/**
 * "当前激活的是谁 + 它的活字段" 的唯一入口。除 overrides 折叠
 * （读 settings 持久化快照，见 overlay.ts）之外，任何代码不得自行读
 * profile.active 拼路径 —— 后续加 per-session 绑定时只改这里。
 * sessionProfile 本期恒为 undefined（预留缝，与 pet 的 behaviorMode
 * 同样走 RunParams 的模式在第二阶段接入）。
 */
import type { SettingsManager } from "../settings/manager.js";
import { logger } from "../logging/logger.js";
import { readWorkspaceProfile } from "./store.js";
import type { WorkspaceProfileSubtree } from "./activation.js";
import type { WorkspaceProfile } from "./types.js";

export interface ResolveActiveWorkspaceProfileInput {
  /** 未来 per-session 绑定的入口；本期调用方一律不传。 */
  sessionProfile?: string;
  cwd: string;
  settings: SettingsManager;
}

function readSubtree(sm: SettingsManager, cwd: string): WorkspaceProfileSubtree | undefined {
  try {
    return sm.getForScope("project", cwd).profile as WorkspaceProfileSubtree | undefined;
  } catch {
    return undefined;
  }
}

export function resolveActiveWorkspaceProfile(
  input: ResolveActiveWorkspaceProfileInput,
): WorkspaceProfile | undefined {
  const name = input.sessionProfile ?? readSubtree(input.settings, input.cwd)?.active;
  if (!name) return undefined;
  let profile: WorkspaceProfile | undefined;
  try {
    profile = readWorkspaceProfile(name);
  } catch (error) {
    logger.warn("profile.active_invalid", {
      cat: "profile",
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (!profile) {
    logger.warn("profile.active_missing_from_library", { cat: "profile", name });
  }
  return profile;
}

/** preset 解析用的快照读取（优先级：agent.preset > 本值 > capability 默认）。 */
export function workspaceProfilePresetFor(sm: SettingsManager, cwd: string): string | undefined {
  return readSubtree(sm, cwd)?.preset;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/profile/resolve.test.ts`
Expected: PASS（5 pass）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/profile/resolve.ts packages/core/src/profile/resolve.test.ts
git commit -m "feat(profile): resolveActiveWorkspaceProfile with session seam"
```

---

### Task 6: 能力折叠咽喉（overrides 合并 + 替换 4 个读取点）

**Files:**
- Modify: `packages/core/src/capability-control/overlay.ts`（追加两个函数）
- Modify: `packages/core/src/capability-control/disabled-lists.ts:44-46`
- Modify: `packages/core/src/engine/engine.ts:3899` 与 `:3917` 附近（两个私有 helper）
- Modify: `packages/core/src/capability-control/service.ts:101-109`
- Test: `packages/core/src/capability-control/profile-overlay.test.ts`

优先级语义：**用户手写 `capabilityOverrides` 按 key 赢过 `profile.overrides`**，两者都为三态，合并 = 逐 bucket `{...profile层, ...用户层}`。

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/capability-control/profile-overlay.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import { effectiveProjectOverrides, mergeCapabilityOverrides } from "./overlay.js";

describe("mergeCapabilityOverrides", () => {
  test("user layer wins per key; unique keys from both survive", () => {
    expect(
      mergeCapabilityOverrides(
        { plugins: { a: "on", b: "on" }, skills: { s: "on" } },
        { plugins: { a: "off" }, agents: { g: "off" } },
      ),
    ).toEqual({
      plugins: { a: "off", b: "on" },
      skills: { s: "on" },
      agents: { g: "off" },
    });
  });

  test("either side undefined passes the other through", () => {
    expect(mergeCapabilityOverrides(undefined, { skills: { x: "on" } })).toEqual({ skills: { x: "on" } });
    expect(mergeCapabilityOverrides({ skills: { x: "on" } }, undefined)).toEqual({ skills: { x: "on" } });
    expect(mergeCapabilityOverrides(undefined, undefined)).toBeUndefined();
  });
});

describe("effectiveProjectOverrides", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cs-eff-ov-"));
    cwd = join(home, "ws");
    mkdirSync(cwd, { recursive: true });
    prevHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("folds profile.overrides under user capabilityOverrides", () => {
    const sm = new SettingsManager(cwd, "full");
    sm.saveProjectSetting("profile", {
      active: "seedance",
      overrides: { plugins: { "seedance-pack": "on", shared: "on" } },
    }, cwd);
    sm.saveProjectSetting("capabilityOverrides", { plugins: { shared: "off" } }, cwd);
    expect(effectiveProjectOverrides(sm, cwd)).toEqual({
      plugins: { "seedance-pack": "on", shared: "off" },
    });
  });

  test("no cwd → undefined; no overrides at all → undefined", () => {
    const sm = new SettingsManager(cwd, "full");
    expect(effectiveProjectOverrides(sm, undefined)).toBeUndefined();
    expect(effectiveProjectOverrides(sm, cwd)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/capability-control/profile-overlay.test.ts`
Expected: FAIL

- [ ] **Step 3: Add the two functions to overlay.ts**

在 `packages/core/src/capability-control/overlay.ts` 末尾追加（顶部补 `import type { SettingsManager } from "../settings/manager.js";`——先确认无 import 环：settings/manager 不 import capability-control，安全）：

```ts
const OVERRIDE_BUCKETS = ["skills", "plugins", "agents", "mcp", "builtin", "pluginHooks"] as const;

/**
 * 合并两层三态 overlay：`top`（用户手写 capabilityOverrides）按 key 赢过
 * `base`（profile.overrides 快照）。空结果收敛为 undefined。
 */
export function mergeCapabilityOverrides(
  base: CapabilityOverrides | undefined,
  top: CapabilityOverrides | undefined,
): CapabilityOverrides | undefined {
  if (!base) return top;
  if (!top) return base;
  const merged: NonNullable<CapabilityOverrides> = {};
  for (const bucket of OVERRIDE_BUCKETS) {
    const combined = { ...(base[bucket] ?? {}), ...(top[bucket] ?? {}) };
    if (Object.keys(combined).length > 0) merged[bucket] = combined;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * 项目 overrides 的唯一读取咽喉：profile 快照垫底、用户手写覆盖。
 * 所有折叠消费方（engine / disabled-lists / capability service）必须
 * 经这里读，不得再直接 getForScope().capabilityOverrides。
 */
export function effectiveProjectOverrides(
  sm: SettingsManager,
  cwd: string | undefined,
): CapabilityOverrides | undefined {
  if (!cwd) return undefined;
  try {
    const scoped = sm.getForScope("project", cwd) as {
      capabilityOverrides?: CapabilityOverrides;
      profile?: { overrides?: CapabilityOverrides };
    };
    return mergeCapabilityOverrides(scoped.profile?.overrides, scoped.capabilityOverrides);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Replace the four read sites**

1. `packages/core/src/capability-control/disabled-lists.ts:44-46` — 把
   ```ts
   const overrides = cwd
     ? (sm.getForScope("project", cwd).capabilityOverrides as CapabilityOverrides | undefined)
     : undefined;
   ```
   替换为
   ```ts
   const overrides = effectiveProjectOverrides(sm, cwd);
   ```
   并在 import 里从 `./overlay.js` 增加 `effectiveProjectOverrides`。
2. `packages/core/src/engine/engine.ts:3899` 附近（agents overlay helper）— 同样替换该行的 `sm.getForScope(...).capabilityOverrides as ...` 为 `effectiveProjectOverrides(sm, cwd)`，import 自 `../capability-control/overlay.js`（engine.ts:116 已 import 该模块，扩展即可）。
3. `packages/core/src/engine/engine.ts:3917` 附近（builtin overlay helper）— 同上替换。
4. `packages/core/src/capability-control/service.ts:101-103` — 该处 `overrides` 同时供 **effective enabled 计算**（:109）与 **UI 三态显示**（:114 `projectOverride`）。改为分层：
   ```ts
   const userOverrides: CapabilityOverrides | undefined = cwd
     ? (this.deps.settings.getForScope("project", cwd).capabilityOverrides as CapabilityOverrides)
     : undefined;
   const foldedOverrides = cwd ? effectiveProjectOverrides(this.deps.settings, cwd) : undefined;
   ```
   然后 `:108` 的 `ov`（喂给 `applyOverride` 算 `enabled`）改用 `foldedOverrides`；`:114` 的 `projectOverride`（UI 三态选择器显示）继续用 `overrideFor(userOverrides, ...)` —— **UI 只显示用户手写层，enabled 反映合并现实**。

- [ ] **Step 5: Verify no direct read remains**

Run: `grep -rn 'getForScope("project"' packages/core/src --include='*.ts' | grep capabilityOverrides | grep -v overlay.ts | grep -v '\.test\.'`
Expected: 仅剩 service.ts 中 `userOverrides` 那一处（UI 显示层，允许），无其他直接读取。

- [ ] **Step 6: Run tests**

Run: `bun test packages/core/src/capability-control/ packages/core/src/engine/ 2>&1 | tail -5`
Expected: 全 PASS（现有 overlay/capability 测试不回归）

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/capability-control/ packages/core/src/engine/engine.ts
git commit -m "feat(profile): fold profile.overrides under user capabilityOverrides via single choke point"
```

---

### Task 7: preset 优先级（agent.preset > profile.preset > capability 默认）

**Files:**
- Modify: `packages/core/src/cli/agent-server-stdio.ts:94` 与 `:175`
- Modify: `packages/core/src/engine/disk-defaults.ts`
- Test: `packages/core/src/engine/disk-defaults.test.ts`（存在则扩展；不存在则新建）

- [ ] **Step 1: Write the failing test**

新建/扩展 `packages/core/src/engine/disk-defaults.profile-preset.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { diskDefaultsFrom } from "./disk-defaults.js";
import { SettingsSchema } from "../settings/schema.js";

describe("diskDefaultsFrom profile preset fallback", () => {
  test("agent.preset wins over profile.preset", () => {
    const s = SettingsSchema.parse({
      agent: { preset: "harness-min" },
      profile: { active: "x", preset: "general" },
    });
    expect(diskDefaultsFrom(s).preset).toBe("harness-min");
  });

  test("profile.preset used when agent.preset unset", () => {
    const s = SettingsSchema.parse({ profile: { active: "x", preset: "general" } });
    expect(diskDefaultsFrom(s).preset).toBe("general");
  });

  test("both unset → undefined (capability default downstream)", () => {
    const s = SettingsSchema.parse({});
    expect(diskDefaultsFrom(s).preset).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/engine/disk-defaults.profile-preset.test.ts`
Expected: FAIL（profile.preset 未被采用）

- [ ] **Step 3: Implement**

`packages/core/src/engine/disk-defaults.ts:60` 把 `preset: agent.preset,` 改为：

```ts
    // preset 优先级：用户显式 agent.preset > 激活数字人的 profile.preset >
    // capability 默认（resolveAgentPreset 内）。settings 已含合并后的
    // project 层，profile 子树随之而来。
    preset: agent.preset ?? settings.profile?.preset,
```

`packages/core/src/cli/agent-server-stdio.ts:94`（engineFactory；注释明言与 diskDefaultsFrom 必须镜像）：

```ts
    preset: slice.preset ?? settings.agent.preset ?? settings.profile?.preset,
```

`packages/core/src/cli/agent-server-stdio.ts:175`（另一处 config 构建）同样把 `preset: settings.agent.preset,` 改为 `preset: settings.agent.preset ?? settings.profile?.preset,`。改前读两处上下文各 ±10 行确认 `settings` 是合并后的 ValidatedSettings（含 project 层）；若某处 settings 只有 user 层，则该处保持不动并在 commit message 里说明。

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/engine/disk-defaults.profile-preset.test.ts packages/core/src/cli/ 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/disk-defaults.ts packages/core/src/cli/agent-server-stdio.ts packages/core/src/engine/disk-defaults.profile-preset.test.ts
git commit -m "feat(profile): preset priority agent.preset > profile.preset"
```

---

### Task 8: composer 主指令注入 + engine 接线

**Files:**
- Modify: `packages/core/src/prompt/composer.ts`（ComposerOptions ~19-65 行；getSections ~175-272 行）
- Modify: `packages/core/src/engine/engine.ts:1911` 附近（PromptComposer 构建）
- Test: `packages/core/src/prompt/composer.profile.test.ts`

Section 排序即优先级：`behavior`（preset sections）→ **`profile_main_instruction`（新）** → `append_system`（用户显式 append，赢过数字人）→ `personalization`。CLAUDE.md 指令走 `buildUserContextMessage`（system 之后的独立消息）天然最"具体" → 已决策优先级 `CLAUDE.md > mainInstruction > preset` 自动成立。

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/prompt/composer.profile.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptComposer } from "./composer.js";

const cwd = mkdtempSync(join(tmpdir(), "cs-composer-profile-"));

describe("composer profile main instruction", () => {
  test("injects the section between preset behavior and append_system", async () => {
    const composer = new PromptComposer({
      cwd,
      model: "test-model",
      profileMainInstruction: "你是制片人，按三阶段调度。",
      appendSystemPrompt: "APPEND-MARKER",
    });
    const prompt = await composer.buildSystemPrompt([]);
    const main = prompt.indexOf("你是制片人");
    const append = prompt.indexOf("APPEND-MARKER");
    expect(main).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(main); // 用户 append 更靠后 → 更优先
    expect(prompt).toContain("# Digital-Human Main Instruction");
  });

  test("absent instruction adds no section", async () => {
    const composer = new PromptComposer({ cwd, model: "test-model" });
    const prompt = await composer.buildSystemPrompt([]);
    expect(prompt).not.toContain("Digital-Human Main Instruction");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/prompt/composer.profile.test.ts`
Expected: FAIL（unknown option / 无 section）

- [ ] **Step 3: Implement composer option + section**

`ComposerOptions`（composer.ts ~35 行 `userProfile` 旁）加：

```ts
  /**
   * 激活数字人（WorkspaceProfile）的主指令。排序在 preset behavior 之后、
   * appendSystemPrompt 之前 —— 本地 CLAUDE.md（user-context 消息）与用户
   * append 都比它更"具体/优先"。来源：engine 经 resolveActiveWorkspaceProfile
   * 解析后传入；composer 不自行读盘。
   */
  profileMainInstruction?: string;
```

`getSections()` 里 `behavior` section push（~220-238 行）**之后**、`appendSystemPrompt`（~248 行）**之前**插入：

```ts
    // 数字人主指令 —— 见 profileMainInstruction 的 doc comment。
    if (this.options.profileMainInstruction) {
      sections.push({
        name: "profile_main_instruction",
        compute: () => `# Digital-Human Main Instruction\n\n${this.options.profileMainInstruction!}`,
      });
    }
```

- [ ] **Step 4: Wire engine**

`packages/core/src/engine/engine.ts:1910` 附近（`const { disabledSkills, disabledPlugins } = this.readDisabledLists();` 之后、`new PromptComposer({` 之前）加：

```ts
      // WorkspaceProfile（数字人）：mainInstruction 从库活读（settings 只记名字）。
      // 命名注意：局部变量 `profile` 已被 RunBehaviorProfile 占用（见 :1917）。
      const workspaceProfile = resolveActiveWorkspaceProfile({
        cwd,
        settings: this.getSettingsManager(),
      });
```

`new PromptComposer({...})` 参数里 `userProfile: this.config.userProfile,` 之后加：

```ts
        profileMainInstruction: workspaceProfile?.mainInstruction,
```

顶部 import 区加：

```ts
import { resolveActiveWorkspaceProfile } from "../profile/resolve.js";
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/core/src/prompt/ 2>&1 | tail -5 && bun test packages/core/src/engine/ 2>&1 | tail -5`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/prompt/composer.ts packages/core/src/prompt/composer.profile.test.ts packages/core/src/engine/engine.ts
git commit -m "feat(profile): inject digital-human main instruction into system prompt"
```

---

### Task 9: 记忆第三层（全局 → 数字人 → 局部）

**Files:**
- Modify: `packages/core/src/session/memory.ts`（`buildInjectionIndex`，~798 行）
- Modify: `packages/core/src/prompt/composer.ts`（`getMemoryContext` ~281-294 行 + ComposerOptions）
- Modify: `packages/core/src/engine/engine.ts`（Task 8 加的 `workspaceProfile` 处传 memory dir）
- Test: `packages/core/src/session/memory.profile-layer.test.ts`

- [ ] **Step 1: Write the failing test**

先读 `packages/core/src/session/memory.ts` 的 `MemoryManager.add` / `loadScope` 签名（~186 行 constructor 之后），用真实 API 写入测试数据；下面假定存在 `add`-风格写入，如签名不同按实际调整（保持断言不变）：

```ts
// packages/core/src/session/memory.profile-layer.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-mem-profile-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("buildInjectionIndex profile layer", () => {
  test("orders sections global → digital-human → project", () => {
    const globalMm = new MemoryManager({ baseDir: home });
    const profileDir = join(home, "profiles", "seedance");
    const profileMm = new MemoryManager({ baseDir: profileDir });
    const projectDir = join(home, "ws");
    const projectMm = new MemoryManager({ baseDir: home, projectDir });
    // 用 MemoryManager 的真实写入 API 各写一条（读 memory.ts 确认方法名，
    // 现有 memory 测试文件是最好的样板 —— 模仿它写入）。
    globalMm.add({ name: "g", description: "global fact", type: "user" });
    profileMm.add({ name: "p", description: "digital-human fact", type: "user" });
    projectMm.add({ name: "l", description: "project fact", type: "user" });

    const index = MemoryManager.buildInjectionIndex({
      baseDir: home,
      projectDir,
      profileDir,
    });
    const g = index.indexOf("global fact");
    const p = index.indexOf("digital-human fact");
    const l = index.indexOf("project fact");
    expect(g).toBeGreaterThan(-1);
    expect(p).toBeGreaterThan(g);
    expect(l).toBeGreaterThan(p);
    expect(index).toContain("## Digital-human memories");
  });

  test("no profileDir → no digital-human section", () => {
    const index = MemoryManager.buildInjectionIndex({ baseDir: home });
    expect(index).not.toContain("Digital-human memories");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/session/memory.profile-layer.test.ts`
Expected: FAIL（unknown option `profileDir`）。若 `add` 方法名不对先按 memory.ts 实际 API 修测试再跑到"因 profileDir 失败"为止。

- [ ] **Step 3: Extend buildInjectionIndex**

`memory.ts` 的 `buildInjectionIndex`（~798 行）：opts 增加 `profileDir?: string;`；在 `const project = ...` 之后加：

```ts
    // 数字人层：baseDir 直接指向 profiles/<name>（其 memory/ 子目录随
    // MemoryManager 的常规布局落盘）。跟着 Profile 走、跨 workspace 复用。
    const profile = opts.profileDir ? new MemoryManager({ baseDir: opts.profileDir }) : null;
```

`const projectEntries = ...` 旁加 `const profileEntries = profile ? collect(profile) : [];`；空判断改为三者皆空才 return ""；输出段落在 Global 与 Project **之间**插入：

```ts
    if (profileEntries.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("## Digital-human memories (travel with the active profile)");
      for (const e of profileEntries) lines.push(fmt(e));
    }
```

- [ ] **Step 4: Thread through composer + engine**

composer.ts：`ComposerOptions` 加

```ts
  /** 激活数字人的可移植记忆层根目录（portableMemory=true 时由 engine 传入）。 */
  profileMemoryDir?: string;
```

`getMemoryContext()`（~287 行）的调用改为：

```ts
      return MemoryManager.buildInjectionIndex({
        projectDir: this.options.cwd,
        profileDir: this.options.profileMemoryDir,
        maxAgeDays: this.options.memoriesMaxAgeDays,
      });
```

engine.ts（Task 8 的 `workspaceProfile` 已在作用域）：PromptComposer 参数里 `profileMainInstruction` 之后加：

```ts
        profileMemoryDir: workspaceProfile?.portableMemory
          ? workspaceProfileDir(workspaceProfile.name)
          : undefined,
```

import 区把 `../profile/resolve.js` 那行旁边加：

```ts
import { workspaceProfileDir } from "../profile/store.js";
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/core/src/session/ packages/core/src/prompt/ 2>&1 | tail -5`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/session/memory.ts packages/core/src/session/memory.profile-layer.test.ts packages/core/src/prompt/composer.ts packages/core/src/engine/engine.ts
git commit -m "feat(profile): portable digital-human memory layer (global → profile → project)"
```

---

### Task 10: 模块出口 + core 公共导出

**Files:**
- Create: `packages/core/src/profile/index.ts`
- Modify: `packages/core/src/index.ts`（在 `export { createOffBackend } ...`（~147 行）之后的公共导出区加一段）

- [ ] **Step 1: Barrel**

```ts
// packages/core/src/profile/index.ts
export {
  WORKSPACE_PROFILE_NAME_RE,
  WorkspaceProfileSchema,
  type WorkspaceProfile,
} from "./types.js";
export {
  listWorkspaceProfiles,
  readWorkspaceProfile,
  saveWorkspaceProfile,
  workspaceProfileDir,
  workspaceProfilesRoot,
} from "./store.js";
export {
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  profileOverridesFromDefinition,
  type WorkspaceProfileSubtree,
} from "./activation.js";
export {
  resolveActiveWorkspaceProfile,
  workspaceProfilePresetFor,
  type ResolveActiveWorkspaceProfileInput,
} from "./resolve.js";
```

- [ ] **Step 2: Public export**

`packages/core/src/index.ts` 公共导出区（tool-system 导出附近）加：

```ts
// ─── WorkspaceProfile（数字人）harness 元机制 ─────────────────────
export {
  WorkspaceProfileSchema,
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  listWorkspaceProfiles,
  readWorkspaceProfile,
  resolveActiveWorkspaceProfile,
  saveWorkspaceProfile,
  workspaceProfileDir,
  workspaceProfilesRoot,
  type WorkspaceProfile,
  type WorkspaceProfileSubtree,
} from "./profile/index.js";
```

- [ ] **Step 3: Run the export contract test**

Run: `bun test packages/core/src/index.exports.test.ts`
Expected: PASS。该测试约束 **internal** 入口（`index.internal.ts`）的清单——我们只加了公共导出，internal 清单不变；若失败，读测试输出并按其分区规则处理（本会话已有先例：公共+internal 双导出时要同时登记）。

- [ ] **Step 4: Full core test + commit**

Run: `bun test packages/core/ 2>&1 | tail -5`（全 PASS）

```bash
git add packages/core/src/profile/index.ts packages/core/src/index.ts
git commit -m "feat(profile): public exports for the workspace profile API"
```

---

### Task 11: desktop main — profiles service + IPC + preload

**Files:**
- Create: `packages/desktop/src/main/profiles-service.ts`
- Modify: `packages/desktop/src/main/index.ts`（IPC 注册区，参考 `capabilities:setOverride` 在 ~1600 行的形态）
- Modify: `packages/desktop/src/preload/index.ts`（`listCapabilities` ~895 行旁）
- Modify: `packages/desktop/src/preload/types.d.ts`（同名 API 类型声明；模仿 `listCapabilities` 的既有声明形态）
- Test: `packages/desktop/src/main/profiles-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/desktop/src/main/profiles-service.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkspaceProfile } from "@cjhyy/code-shell-core";
import { activateProfile, deactivateProfile, listProfiles } from "./profiles-service.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-desk-profiles-"));
  cwd = join(home, "ws");
  mkdirSync(cwd, { recursive: true });
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  saveWorkspaceProfile({
    name: "seedance", label: "Seedance", basePreset: "general",
    plugins: [], skills: [], mcp: [], agents: [], portableMemory: false,
  });
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("desktop profiles service", () => {
  test("lists library profiles with active mark for a cwd", () => {
    activateProfile(cwd, "seedance");
    const out = listProfiles(cwd);
    expect(out).toEqual([
      { name: "seedance", label: "Seedance", description: undefined, active: true, portableMemory: false },
    ]);
  });

  test("activate writes the subtree; deactivate removes it", () => {
    activateProfile(cwd, "seedance");
    const raw = () => JSON.parse(readFileSync(join(cwd, ".code-shell", "settings.json"), "utf-8"));
    expect(raw().profile.active).toBe("seedance");
    deactivateProfile(cwd);
    expect(raw().profile).toBeUndefined();
    expect(listProfiles(cwd)[0]?.active).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/desktop/src/main/profiles-service.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the service**

```ts
// packages/desktop/src/main/profiles-service.ts
/**
 * WorkspaceProfile（数字人）的 desktop main 门面。与 capabilities-service
 * 相同的组合方式：直接 import core 公共 API，per-call 建 SettingsManager。
 * 激活/关闭写的是项目 settings（原子事务在 core），worker 经现有 settings
 * 热重载在下一轮生效 —— 无需额外通知通道。
 */
import {
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  listWorkspaceProfiles,
  resolveActiveWorkspaceProfile,
  SettingsManager,
} from "@cjhyy/code-shell-core";

export interface ProfileListEntry {
  name: string;
  label: string;
  description: string | undefined;
  active: boolean;
  portableMemory: boolean;
}

export function listProfiles(cwd: string): ProfileListEntry[] {
  const sm = new SettingsManager(cwd, "full");
  const active = resolveActiveWorkspaceProfile({ cwd, settings: sm })?.name;
  return listWorkspaceProfiles().map((p) => ({
    name: p.name,
    label: p.label,
    description: p.description,
    active: p.name === active,
    portableMemory: p.portableMemory,
  }));
}

export function activateProfile(cwd: string, name: string): void {
  const sm = new SettingsManager(cwd, "full");
  activateWorkspaceProfile(sm, name, cwd);
}

export function deactivateProfile(cwd: string): void {
  const sm = new SettingsManager(cwd, "full");
  deactivateWorkspaceProfile(sm, cwd);
}
```

若 core 的 `SettingsManager` 未从公共入口导出（Task 10 未包含它——它在 index.extension.ts 有导出），改从既有公共导出确认：`grep -n 'SettingsManager' packages/core/src/index.ts`；没有则本文件像 capabilities-service.ts 一样的 import 源（读其 :18-32 行照抄 import 路径）。

- [ ] **Step 4: IPC + preload**

`packages/desktop/src/main/index.ts`：import 区加 `import { activateProfile, deactivateProfile, listProfiles } from "./profiles-service.js";`，在 `capabilities:setOverride` handler（~1600 行）之后加：

```ts
ipcMain.handle("profiles:list", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("profiles:list requires cwd");
  return listProfiles(cwd);
});
ipcMain.handle("profiles:activate", async (_e, cwd: string, name: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("profiles:activate requires cwd");
  if (typeof name !== "string" || !name) throw new Error("profiles:activate requires name");
  activateProfile(cwd, name);
});
ipcMain.handle("profiles:deactivate", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("profiles:deactivate requires cwd");
  deactivateProfile(cwd);
});
```

`packages/desktop/src/preload/index.ts`（`listCapabilities` ~895 行旁）加：

```ts
  listProfiles: (cwd: string) => ipcRenderer.invoke("profiles:list", cwd),
  activateProfile: (cwd: string, name: string) => ipcRenderer.invoke("profiles:activate", cwd, name),
  deactivateProfile: (cwd: string) => ipcRenderer.invoke("profiles:deactivate", cwd),
```

`packages/desktop/src/preload/types.d.ts`：找到 `listCapabilities` 的类型声明，仿照加：

```ts
  listProfiles(cwd: string): Promise<Array<{ name: string; label: string; description: string | undefined; active: boolean; portableMemory: boolean }>>;
  activateProfile(cwd: string, name: string): Promise<void>;
  deactivateProfile(cwd: string): Promise<void>;
```

- [ ] **Step 5: Run tests + desktop typecheck**

Run: `bun test packages/desktop/src/main/profiles-service.test.ts && cd packages/desktop && bun run typecheck && cd ../..`
Expected: PASS + typecheck 无错误

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/profiles-service.ts packages/desktop/src/main/profiles-service.test.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/
git commit -m "feat(desktop): profiles IPC service and preload surface"
```

---

### Task 12: desktop renderer — 数字人 settings 区块 + i18n

**Files:**
- Create: `packages/desktop/src/renderer/settings/ProfileSection.tsx`
- Modify: `packages/desktop/src/renderer/settings/SettingsPage.tsx`（注册区块）
- Modify: `packages/desktop/src/renderer/i18n/ns/settings.ts`（两种语言各加 keys；若 settings ns 文件名不同，`ls packages/desktop/src/renderer/i18n/ns/` 找对应文件，模仿 pet.ts 的双语块结构）
- Test: `packages/desktop/src/renderer/settings/ProfileSection.test.tsx`

遵循 desktop CLAUDE.md：只用 `@/components/ui` 组件（Button/Card/Badge…）+ Tailwind 语义 token，不写裸 `<button>`。

- [ ] **Step 1: Write the component**

```tsx
// packages/desktop/src/renderer/settings/ProfileSection.tsx
import React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";

interface ProfileEntry {
  name: string;
  label: string;
  description: string | undefined;
  active: boolean;
  portableMemory: boolean;
}

/** 数字人（WorkspaceProfile）管理区块：列库、激活/切换/关闭。 */
export function ProfileSection({ cwd }: { cwd: string }) {
  const { t } = useTranslation("settings");
  const [profiles, setProfiles] = React.useState<ProfileEntry[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setProfiles(await window.codeshell.listProfiles(cwd));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cwd]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t("profiles.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("profiles.subtitle")}</p>
      </div>
      {error ? <p className="text-xs text-status-err">{error}</p> : null}
      {profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("profiles.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {profiles.map((p) => (
            <li key={p.name} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground">{p.label}</span>
                  {p.active ? <Badge variant="default">{t("profiles.activeBadge")}</Badge> : null}
                  {p.portableMemory ? (
                    <Badge variant="secondary">{t("profiles.memoryBadge")}</Badge>
                  ) : null}
                </div>
                {p.description ? (
                  <p className="truncate text-xs text-muted-foreground">{p.description}</p>
                ) : null}
              </div>
              {p.active ? (
                <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => void act(() => window.codeshell.deactivateProfile(cwd))}>
                  {t("profiles.deactivate")}
                </Button>
              ) : (
                <Button size="sm" disabled={busy}
                  onClick={() => void act(() => window.codeshell.activateProfile(cwd, p.name))}>
                  {t("profiles.activate")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 2: i18n keys**

在 settings 的 i18n ns 文件里（中文块 / 英文块各一份，结构模仿同文件既有区块）：

```ts
      profiles: {
        title: "数字人",
        subtitle: "给这个 Workspace 激活一个数字同事：人设、能力与经验随之上线；关闭即消失",
        empty: "全局库还没有数字人（~/.code-shell/profiles/）。参考 docs/examples/workspace-profile-sample.md 创建一个。",
        activeBadge: "当前",
        memoryBadge: "可移植经验",
        activate: "激活",
        deactivate: "关闭",
      },
```

```ts
      profiles: {
        title: "Digital humans",
        subtitle: "Activate a digital colleague for this workspace: persona, capabilities and memory come online together",
        empty: "No profiles in the global library yet (~/.code-shell/profiles/). See docs/examples/workspace-profile-sample.md.",
        activeBadge: "Active",
        memoryBadge: "Portable memory",
        activate: "Activate",
        deactivate: "Deactivate",
      },
```

- [ ] **Step 3: Register in SettingsPage**

读 `packages/desktop/src/renderer/settings/SettingsPage.tsx`，找到 `CapabilitiesOverviewSection` 的渲染位置，在其后按同样的布局容器加 `<ProfileSection cwd={当前项目 cwd 的同名变量} />`（cwd 的取法与 CapabilitiesOverviewSection 拿 cwd 的方式一致）。

- [ ] **Step 4: Test**

```tsx
// packages/desktop/src/renderer/settings/ProfileSection.test.tsx
// 模仿 packages/desktop/src/renderer/pet/PetWidget.test.tsx 的渲染测试基建
// （happy-dom / testing-library 的用法以现有测试文件为准）。断言：
// 1) listProfiles 返回两项时渲染两行；active 的一行显示"当前"徽标和"关闭"按钮。
// 2) 点击"激活"调用 window.codeshell.activateProfile(cwd, name) 并触发一次 refresh。
// window.codeshell 用 mock 注入（现有 renderer 测试同款方式）。
```

按上述断言写出完整测试（以现有 renderer 测试为样板），确保两条断言都落地。

- [ ] **Step 5: Run + typecheck + commit**

Run: `bun test packages/desktop/src/renderer/settings/ProfileSection.test.tsx && cd packages/desktop && bun run typecheck && cd ../..`
Expected: PASS

```bash
git add packages/desktop/src/renderer/settings/ProfileSection.tsx packages/desktop/src/renderer/settings/ProfileSection.test.tsx packages/desktop/src/renderer/settings/SettingsPage.tsx packages/desktop/src/renderer/i18n/
git commit -m "feat(desktop): digital-human profile section in settings"
```

---

### Task 13: TopBar 当前数字人指示

**Files:**
- Modify: `packages/desktop/src/renderer/TopBar.tsx`（或 `renderer/topbar/WorkspaceIndicator.tsx`——先读两个文件，把指示放进 workspace 指示器旁最自然的位置）
- Test: 扩展 `packages/desktop/src/renderer/topbar/WorkspaceIndicator.test.tsx`（若指示放在 TopBar 则新建对应测试）

- [ ] **Step 1: Implement**

在 workspace 指示器组件里：用 `window.codeshell.listProfiles(cwd)` 取 active 项（`useEffect` + cwd 依赖；订阅方式与该组件现有数据刷新方式一致），有 active 时渲染：

```tsx
<span className="ml-2 rounded-sm bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
  {activeProfileLabel}
</span>
```

无 active 不渲染任何东西。点击行为：调用该组件跳转 settings 页的既有导航回调（读组件内现有导航用法；若无现成回调则本期只显示不可点，不新造导航通路）。

- [ ] **Step 2: Test**

扩展现有 WorkspaceIndicator 测试：mock `window.codeshell.listProfiles` 返回一个 active 项 → 断言 label 出现；返回空 → 断言不出现。

- [ ] **Step 3: Run + commit**

Run: `bun test packages/desktop/src/renderer/topbar/ && cd packages/desktop && bun run typecheck && cd ../..`
Expected: PASS

```bash
git add packages/desktop/src/renderer/
git commit -m "feat(desktop): show active digital human in the top bar"
```

---

### Task 14: 样例文档 + 全量回归

**Files:**
- Create: `docs/examples/workspace-profile-sample.md`

- [ ] **Step 1: Sample doc**

````markdown
# WorkspaceProfile（数字人）样例

全局库位置：`~/.code-shell/profiles/<name>/profile.json`。core 不内置任何领域 profile；
下面是一个 seedance 形态的完整样例。创建后在 Desktop 设置页「数字人」区块激活，
或在代码里调用 `activateWorkspaceProfile(sm, "seedance", cwd)`。

```json
{
  "name": "seedance",
  "label": "Seedance 分镜制片人",
  "description": "把剧本拆成 Seedance 提示词的制片人团队",
  "basePreset": "general",
  "plugins": ["seedance-pack"],
  "skills": [],
  "mcp": [],
  "agents": ["director", "art-designer", "storyboard-artist"],
  "mainInstruction": "你是制片人。收到剧本任务时按三阶段调度：先调 director 分析剧本结构，再调 art-designer 出服化道设定，最后调 storyboard-artist 生成分镜提示词。每阶段产出确认后再进入下一阶段。",
  "portableMemory": true,
  "version": "0.1.0"
}
```

要点：
- `plugins`/`skills`/`mcp`/`agents` 里的名字必须是已安装能力的名字；激活只是 force-enable，不负责安装。
- `portableMemory: true` → `~/.code-shell/profiles/seedance/` 下会累积这个数字人的可移植经验，跨 workspace 复用。
- 项目差异（品牌色、路径、技术栈）不写进 profile，写进各 workspace 的 `CLAUDE.md`（优先级高于 mainInstruction）。
- 优先级：本地 CLAUDE.md > mainInstruction > basePreset prompt sections；用户手写 capabilityOverrides > profile 展开的 overrides。
````

- [ ] **Step 2: Full regression**

```bash
bun test 2>&1 | tail -5                      # 全 PASS（基线 6345+，0 fail）
bun run typecheck 2>&1 | grep -c 'error TS'  # 期望 31（等于既有基线，不新增）
cd packages/desktop && bun run typecheck && bun run build && cd ../..
bun run lint 2>&1 | tail -3
```

Expected: 测试 0 fail；root typecheck 错误数 = 31（全部是预先存在的 oauth/mcp-manager/subagent-spawner 等文件）；desktop typecheck/build 通过；lint 无新错误。

- [ ] **Step 3: Commit**

```bash
git add docs/examples/workspace-profile-sample.md
git commit -m "docs(profile): workspace profile sample and priority rules"
```

---

## 验收清单（对照设计稿 §8）

- [ ] 激活 → 项目 settings 出现 `profile` 子树，能力 force-enable、主指令进系统提示、（portableMemory 时）记忆层挂载
- [ ] 切换 → 子树整体替换，旧能力消失、新能力上线
- [ ] 关闭 → 子树删除，用户手写 `capabilityOverrides` 原样保留
- [ ] 用户手写 override 按 key 赢过 profile；`agent.preset` 赢过 `profile.preset`
- [ ] CLAUDE.md > mainInstruction > preset sections 的注入顺序成立（composer 测试证明）
- [ ] 记忆注入顺序：全局 → 数字人 → 局部
- [ ] 库中被删的 active 名字 → 降级为未激活 + warn 日志，不崩
- [ ] desktop：设置页可列/激活/切换/关闭；TopBar 显示当前数字人
- [ ] 导出契约测试、root/desktop typecheck（不新增错误）、全量 bun test 全绿
