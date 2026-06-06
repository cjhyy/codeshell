# Mobile Web Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Electron-hosted Mobile Web Remote that lets a trusted phone chat with CodeShell, approve permissions, and launch Claude Code/Codex managed jobs, including project-default Claude Code dangerous mode.

**Architecture:** Add focused core services for external agent job config/execution, then add an Electron `RemoteHostManager` that serves an authenticated HTTP/WebSocket mobile UI. The mobile UI is a lightweight browser/PWA controller; all execution still goes through existing CodeShell session/run/permission systems or the new external-agent job manager.

**Tech Stack:** Bun test runner, TypeScript, Electron main/preload/renderer, Node `http`, `ws` WebSocket server, existing CodeShell core `BackgroundShellManager`, existing desktop settings/preload IPC patterns.

---

## Scope note

The design spans several subsystems. This plan intentionally slices the work into independently testable tasks:

1. Core config and external-agent job primitives.
2. Claude/Codex adapter execution.
3. Trusted-device and pairing store.
4. Electron remote host HTTP/WebSocket shell.
5. Permission bridge and low-risk auto allow.
6. Mobile HTML UI.
7. Desktop settings UI.
8. End-to-end smoke and docs.

Each task should be committed separately.

---

## File structure

### Core external agent layer

- Create `packages/core/src/external-agents/types.ts`  
  Shared types for agent kinds, modes, job records, output events, and config.
- Create `packages/core/src/external-agents/config.ts`  
  Resolves `settings.externalAgents` into safe defaults and workspace-specific mode decisions.
- Create `packages/core/src/external-agents/manager.ts`  
  Owns managed job lifecycle, delegates spawn to adapters, emits output/status events.
- Create `packages/core/src/external-agents/adapters/claude-code.ts`  
  Claude Code CLI adapter.
- Create `packages/core/src/external-agents/adapters/codex.ts`  
  Codex CLI adapter.
- Create tests beside the implementation:
  - `packages/core/src/external-agents/config.test.ts`
  - `packages/core/src/external-agents/manager.test.ts`
  - `packages/core/src/external-agents/claude-code.test.ts`

### Core settings

- Modify `packages/core/src/settings/schema.ts`  
  Add `externalAgents.claudeCode` and `externalAgents.codex` settings schema.

### Desktop remote host layer

- Create `packages/desktop/src/main/mobile-remote/types.ts`  
  Wire protocol and store types used by Electron main.
- Create `packages/desktop/src/main/mobile-remote/trusted-device-store.ts`  
  Persistent trusted device store.
- Create `packages/desktop/src/main/mobile-remote/pairing.ts`  
  Pairing token lifecycle.
- Create `packages/desktop/src/main/mobile-remote/mobile-ui.ts`  
  Static v1 mobile HTML/JS/CSS string served by the host.
- Create `packages/desktop/src/main/mobile-remote/remote-host-manager.ts`  
  HTTP server, WebSocket auth/session, event routing.
- Create tests:
  - `packages/desktop/src/main/mobile-remote/trusted-device-store.test.ts`
  - `packages/desktop/src/main/mobile-remote/pairing.test.ts`
  - `packages/desktop/src/main/mobile-remote/remote-host-manager.test.ts`

### Desktop integration

- Modify `packages/desktop/package.json`  
  Add `ws` dependency and `@types/ws` dev dependency.
- Modify `packages/desktop/src/main/index.ts`  
  Construct `RemoteHostManager`, register IPC handlers, stop service on shutdown.
- Modify `packages/desktop/src/preload/index.ts` and `packages/desktop/src/preload/types.d.ts`  
  Expose `mobileRemote` APIs to renderer.
- Modify `packages/desktop/src/renderer/settings/AdvancedSections.tsx` or `SettingsPage.tsx`  
  Add Mobile Remote section: start/stop, QR URL text, trusted devices, revoke.

---

## Task 1: Add external agent settings and mode resolution

**Files:**
- Modify: `packages/core/src/settings/schema.ts`
- Create: `packages/core/src/external-agents/types.ts`
- Create: `packages/core/src/external-agents/config.ts`
- Test: `packages/core/src/external-agents/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Create `packages/core/src/external-agents/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveExternalAgentConfig, resolveClaudeModeForWorkspace } from "./config.js";
import type { ExternalAgentsSettings } from "./types.js";

const cwd = "/Users/admin/Documents/个人学习/代码学习/codeshell";

describe("external agent config", () => {
  test("defaults Claude Code to safe mode with no dangerous args", () => {
    const cfg = resolveExternalAgentConfig(undefined);
    expect(cfg.claudeCode.command).toBe("claude");
    expect(cfg.claudeCode.defaultMode).toBe("safe");
    expect(cfg.claudeCode.dangerousArgs).toEqual([]);
    expect(cfg.claudeCode.trustedWorkspaces).toEqual([]);
    expect(cfg.claudeCode.autoStartInTrustedWorkspaces).toBe(false);
  });

  test("allows project default dangerous only in trusted workspace", () => {
    const settings: ExternalAgentsSettings = {
      claudeCode: {
        command: "claude",
        defaultMode: "dangerous",
        dangerousArgs: ["--dangerously-skip-permissions"],
        trustedWorkspaces: [cwd],
        autoStartInTrustedWorkspaces: true,
      },
    };
    const cfg = resolveExternalAgentConfig(settings);
    expect(resolveClaudeModeForWorkspace(cfg.claudeCode, cwd, undefined)).toEqual({
      mode: "dangerous",
      args: ["--dangerously-skip-permissions"],
      requiresHighRiskApproval: false,
      reason: "trusted_workspace_default",
    });
    expect(resolveClaudeModeForWorkspace(cfg.claudeCode, "/tmp/other", undefined)).toEqual({
      mode: "dangerous",
      args: ["--dangerously-skip-permissions"],
      requiresHighRiskApproval: true,
      reason: "dangerous_outside_trusted_workspace",
    });
  });

  test("/cc --safe overrides dangerous default", () => {
    const cfg = resolveExternalAgentConfig({
      claudeCode: {
        defaultMode: "dangerous",
        dangerousArgs: ["--dangerously-skip-permissions"],
        trustedWorkspaces: [cwd],
        autoStartInTrustedWorkspaces: true,
      },
    });
    expect(resolveClaudeModeForWorkspace(cfg.claudeCode, cwd, "safe")).toEqual({
      mode: "safe",
      args: [],
      requiresHighRiskApproval: false,
      reason: "explicit_safe",
    });
  });

  test("/cc --dangerous requests high-risk approval outside trusted workspace", () => {
    const cfg = resolveExternalAgentConfig({
      claudeCode: {
        dangerousArgs: ["--dangerously-skip-permissions"],
        trustedWorkspaces: [cwd],
      },
    });
    expect(resolveClaudeModeForWorkspace(cfg.claudeCode, "/tmp/other", "dangerous")).toEqual({
      mode: "dangerous",
      args: ["--dangerously-skip-permissions"],
      requiresHighRiskApproval: true,
      reason: "explicit_dangerous_outside_trusted_workspace",
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test packages/core/src/external-agents/config.test.ts
```

Expected: FAIL because `packages/core/src/external-agents/config.ts` does not exist.

- [ ] **Step 3: Add shared external-agent types**

Create `packages/core/src/external-agents/types.ts`:

```ts
export type ExternalAgentKind = "claude-code" | "codex";
export type ExternalAgentMode = "safe" | "dangerous";
export type ExternalAgentModeOverride = ExternalAgentMode | undefined;

export interface ClaudeCodeSettings {
  command?: string;
  defaultMode?: ExternalAgentMode;
  dangerousArgs?: string[];
  trustedWorkspaces?: string[];
  autoStartInTrustedWorkspaces?: boolean;
}

export interface CodexSettings {
  command?: string;
  args?: string[];
}

export interface ExternalAgentsSettings {
  claudeCode?: ClaudeCodeSettings;
  codex?: CodexSettings;
}

export interface ResolvedClaudeCodeSettings {
  command: string;
  defaultMode: ExternalAgentMode;
  dangerousArgs: string[];
  trustedWorkspaces: string[];
  autoStartInTrustedWorkspaces: boolean;
}

export interface ResolvedCodexSettings {
  command: string;
  args: string[];
}

export interface ResolvedExternalAgentsConfig {
  claudeCode: ResolvedClaudeCodeSettings;
  codex: ResolvedCodexSettings;
}

export interface ClaudeModeDecision {
  mode: ExternalAgentMode;
  args: string[];
  requiresHighRiskApproval: boolean;
  reason:
    | "explicit_safe"
    | "safe_default"
    | "trusted_workspace_default"
    | "dangerous_outside_trusted_workspace"
    | "explicit_dangerous_trusted_workspace"
    | "explicit_dangerous_outside_trusted_workspace";
}
```

- [ ] **Step 4: Implement config resolution**

Create `packages/core/src/external-agents/config.ts`:

```ts
import type {
  ClaudeModeDecision,
  ExternalAgentModeOverride,
  ExternalAgentsSettings,
  ResolvedClaudeCodeSettings,
  ResolvedExternalAgentsConfig,
} from "./types.js";

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

function isTrustedWorkspace(cwd: string, trustedWorkspaces: string[]): boolean {
  const normalizedCwd = normalizePath(cwd);
  return trustedWorkspaces.some((path) => normalizedCwd === normalizePath(path));
}

export function resolveExternalAgentConfig(
  settings: ExternalAgentsSettings | undefined,
): ResolvedExternalAgentsConfig {
  return {
    claudeCode: {
      command: settings?.claudeCode?.command ?? "claude",
      defaultMode: settings?.claudeCode?.defaultMode ?? "safe",
      dangerousArgs: settings?.claudeCode?.dangerousArgs ?? [],
      trustedWorkspaces: settings?.claudeCode?.trustedWorkspaces ?? [],
      autoStartInTrustedWorkspaces: settings?.claudeCode?.autoStartInTrustedWorkspaces ?? false,
    },
    codex: {
      command: settings?.codex?.command ?? "codex",
      args: settings?.codex?.args ?? [],
    },
  };
}

export function resolveClaudeModeForWorkspace(
  cfg: ResolvedClaudeCodeSettings,
  cwd: string,
  override: ExternalAgentModeOverride,
): ClaudeModeDecision {
  const trusted = isTrustedWorkspace(cwd, cfg.trustedWorkspaces);
  if (override === "safe") {
    return { mode: "safe", args: [], requiresHighRiskApproval: false, reason: "explicit_safe" };
  }
  if (override === "dangerous") {
    return {
      mode: "dangerous",
      args: cfg.dangerousArgs,
      requiresHighRiskApproval: !trusted,
      reason: trusted
        ? "explicit_dangerous_trusted_workspace"
        : "explicit_dangerous_outside_trusted_workspace",
    };
  }
  if (cfg.defaultMode === "dangerous") {
    return {
      mode: "dangerous",
      args: cfg.dangerousArgs,
      requiresHighRiskApproval: !(trusted && cfg.autoStartInTrustedWorkspaces),
      reason: trusted ? "trusted_workspace_default" : "dangerous_outside_trusted_workspace",
    };
  }
  return { mode: "safe", args: [], requiresHighRiskApproval: false, reason: "safe_default" };
}
```

- [ ] **Step 5: Add settings schema fields**

In `packages/core/src/settings/schema.ts`, add an optional `externalAgents` object near other top-level settings. The shape must match this code:

```ts
externalAgents: z
  .object({
    claudeCode: z
      .object({
        command: z.string().optional(),
        defaultMode: z.enum(["safe", "dangerous"]).optional(),
        dangerousArgs: z.array(z.string()).optional(),
        trustedWorkspaces: z.array(z.string()).optional(),
        autoStartInTrustedWorkspaces: z.boolean().optional(),
      })
      .optional(),
    codex: z
      .object({
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .optional(),
```

If the schema exports inferred settings types, ensure `externalAgents` is included through the existing inference path rather than adding a parallel manual type.

- [ ] **Step 6: Run the test**

Run:

```bash
bun test packages/core/src/external-agents/config.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/settings/schema.ts packages/core/src/external-agents/types.ts packages/core/src/external-agents/config.ts packages/core/src/external-agents/config.test.ts
git commit -m "feat(remote): add external agent config"
```

---

## Task 2: Add ExternalAgentJobManager and adapters

**Files:**
- Create: `packages/core/src/external-agents/manager.ts`
- Create: `packages/core/src/external-agents/adapters/claude-code.ts`
- Create: `packages/core/src/external-agents/adapters/codex.ts`
- Modify: `packages/core/src/external-agents/types.ts`
- Test: `packages/core/src/external-agents/manager.test.ts`
- Test: `packages/core/src/external-agents/claude-code.test.ts`

- [ ] **Step 1: Extend external-agent types**

Append to `packages/core/src/external-agents/types.ts`:

```ts
export type ExternalAgentJobStatus = "queued" | "running" | "completed" | "failed" | "killed";

export interface ExternalAgentJob {
  id: string;
  kind: ExternalAgentKind;
  sessionId: string;
  cwd: string;
  prompt: string;
  mode: ExternalAgentMode;
  args: string[];
  status: ExternalAgentJobStatus;
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
}

export type ExternalAgentEvent =
  | { type: "job.started"; job: ExternalAgentJob }
  | { type: "job.output"; jobId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "job.completed"; job: ExternalAgentJob }
  | { type: "job.failed"; job: ExternalAgentJob; error: string }
  | { type: "job.killed"; job: ExternalAgentJob };

export interface StartExternalAgentJobInput {
  kind: ExternalAgentKind;
  sessionId: string;
  cwd: string;
  prompt: string;
  mode?: ExternalAgentMode;
  args?: string[];
  command: string;
}

export interface ExternalAgentAdapter {
  start(input: StartExternalAgentJobInput, onEvent: (event: ExternalAgentEvent) => void): ExternalAgentJob;
  stop(jobId: string): Promise<boolean>;
}
```

- [ ] **Step 2: Write failing manager tests**

Create `packages/core/src/external-agents/manager.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ExternalAgentJobManager } from "./manager.js";
import type { ExternalAgentAdapter, ExternalAgentEvent, StartExternalAgentJobInput } from "./types.js";

class FakeAdapter implements ExternalAgentAdapter {
  starts: StartExternalAgentJobInput[] = [];
  stopped: string[] = [];

  start(input: StartExternalAgentJobInput, onEvent: (event: ExternalAgentEvent) => void) {
    this.starts.push(input);
    const job = {
      id: "job_fake",
      kind: input.kind,
      sessionId: input.sessionId,
      cwd: input.cwd,
      prompt: input.prompt,
      mode: input.mode ?? "safe",
      args: input.args ?? [],
      status: "running" as const,
      startedAt: 123,
    };
    onEvent({ type: "job.started", job });
    return job;
  }

  async stop(jobId: string) {
    this.stopped.push(jobId);
    return true;
  }
}

describe("ExternalAgentJobManager", () => {
  test("starts a job and records events", () => {
    const adapter = new FakeAdapter();
    const events: ExternalAgentEvent[] = [];
    const mgr = new ExternalAgentJobManager({ claudeCode: adapter }, (event) => events.push(event));

    const job = mgr.start({
      kind: "claude-code",
      sessionId: "s1",
      cwd: "/repo",
      prompt: "fix tests",
      command: "claude",
      mode: "dangerous",
      args: ["--dangerously-skip-permissions"],
    });

    expect(job.id).toBe("job_fake");
    expect(adapter.starts[0]?.prompt).toBe("fix tests");
    expect(mgr.get("job_fake")?.status).toBe("running");
    expect(events[0]?.type).toBe("job.started");
  });

  test("stops a running job", async () => {
    const adapter = new FakeAdapter();
    const mgr = new ExternalAgentJobManager({ claudeCode: adapter }, () => {});
    mgr.start({ kind: "claude-code", sessionId: "s1", cwd: "/repo", prompt: "x", command: "claude" });
    await expect(mgr.stop("job_fake")).resolves.toBe(true);
    expect(adapter.stopped).toEqual(["job_fake"]);
  });
});
```

- [ ] **Step 3: Run failing manager tests**

Run:

```bash
bun test packages/core/src/external-agents/manager.test.ts
```

Expected: FAIL because `manager.ts` does not exist.

- [ ] **Step 4: Implement ExternalAgentJobManager**

Create `packages/core/src/external-agents/manager.ts`:

```ts
import type {
  ExternalAgentAdapter,
  ExternalAgentEvent,
  ExternalAgentJob,
  StartExternalAgentJobInput,
} from "./types.js";

export interface ExternalAgentJobManagerAdapters {
  claudeCode: ExternalAgentAdapter;
  codex?: ExternalAgentAdapter;
}

export class ExternalAgentJobManager {
  private jobs = new Map<string, ExternalAgentJob>();

  constructor(
    private readonly adapters: ExternalAgentJobManagerAdapters,
    private readonly onEvent: (event: ExternalAgentEvent) => void,
  ) {}

  start(input: StartExternalAgentJobInput): ExternalAgentJob {
    const adapter = input.kind === "claude-code" ? this.adapters.claudeCode : this.adapters.codex;
    if (!adapter) throw new Error(`No adapter registered for ${input.kind}`);
    const job = adapter.start(input, (event) => {
      if ("job" in event) this.jobs.set(event.job.id, event.job);
      this.onEvent(event);
    });
    this.jobs.set(job.id, job);
    return job;
  }

  get(jobId: string): ExternalAgentJob | undefined {
    return this.jobs.get(jobId);
  }

  listForSession(sessionId: string): ExternalAgentJob[] {
    return [...this.jobs.values()].filter((job) => job.sessionId === sessionId);
  }

  async stop(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    const adapter = job.kind === "claude-code" ? this.adapters.claudeCode : this.adapters.codex;
    if (!adapter) return false;
    return adapter.stop(jobId);
  }
}
```

- [ ] **Step 5: Write failing Claude adapter test**

Create `packages/core/src/external-agents/claude-code.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildClaudeCodeSpawn } from "./adapters/claude-code.js";

describe("ClaudeCodeAdapter", () => {
  test("builds safe spawn args", () => {
    expect(
      buildClaudeCodeSpawn({ command: "claude", prompt: "fix tests", mode: "safe", args: [] }),
    ).toEqual({ command: "claude", args: ["fix tests"] });
  });

  test("builds dangerous spawn args without shell interpolation", () => {
    expect(
      buildClaudeCodeSpawn({
        command: "claude",
        prompt: "fix tests; rm -rf /",
        mode: "dangerous",
        args: ["--dangerously-skip-permissions"],
      }),
    ).toEqual({
      command: "claude",
      args: ["--dangerously-skip-permissions", "fix tests; rm -rf /"],
    });
  });
});
```

- [ ] **Step 6: Implement Claude and Codex adapters**

Create `packages/core/src/external-agents/adapters/claude-code.ts`:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ExternalAgentAdapter,
  ExternalAgentEvent,
  ExternalAgentJob,
  ExternalAgentMode,
  StartExternalAgentJobInput,
} from "../types.js";
import { killProcessGroup } from "../../runtime/spawn-common.js";

export function buildClaudeCodeSpawn(input: {
  command: string;
  prompt: string;
  mode: ExternalAgentMode;
  args: string[];
}): { command: string; args: string[] } {
  return { command: input.command, args: [...input.args, input.prompt] };
}

export class ClaudeCodeAdapter implements ExternalAgentAdapter {
  private children = new Map<string, ChildProcessWithoutNullStreams>();

  start(input: StartExternalAgentJobInput, onEvent: (event: ExternalAgentEvent) => void): ExternalAgentJob {
    const id = `cc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mode = input.mode ?? "safe";
    const args = input.args ?? [];
    const spawnSpec = buildClaudeCodeSpawn({ command: input.command, prompt: input.prompt, mode, args });
    const job: ExternalAgentJob = {
      id,
      kind: "claude-code",
      sessionId: input.sessionId,
      cwd: input.cwd,
      prompt: input.prompt,
      mode,
      args,
      status: "running",
      startedAt: Date.now(),
    };

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: input.cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(id, child);
    onEvent({ type: "job.started", job });

    child.stdout.on("data", (chunk) => {
      onEvent({ type: "job.output", jobId: id, stream: "stdout", text: String(chunk) });
    });
    child.stderr.on("data", (chunk) => {
      onEvent({ type: "job.output", jobId: id, stream: "stderr", text: String(chunk) });
    });
    child.on("error", (err) => {
      const failed = { ...job, status: "failed" as const, completedAt: Date.now() };
      onEvent({ type: "job.failed", job: failed, error: err.message });
    });
    child.on("exit", (exitCode, signal) => {
      this.children.delete(id);
      const completed: ExternalAgentJob = {
        ...job,
        status: exitCode === 0 ? "completed" : "failed",
        completedAt: Date.now(),
        exitCode,
        signal,
      };
      if (exitCode === 0) onEvent({ type: "job.completed", job: completed });
      else onEvent({ type: "job.failed", job: completed, error: `Exited with ${signal ?? exitCode}` });
    });
    return job;
  }

  async stop(jobId: string): Promise<boolean> {
    const child = this.children.get(jobId);
    if (!child?.pid) return false;
    await killProcessGroup(child.pid, { graceMs: 3000 });
    this.children.delete(jobId);
    return true;
  }
}
```

Create `packages/core/src/external-agents/adapters/codex.ts`:

```ts
import { ClaudeCodeAdapter } from "./claude-code.js";

export class CodexAdapter extends ClaudeCodeAdapter {}
```

The Codex adapter intentionally reuses the same process-management behavior in v1. Task-specific command/args come from config.

- [ ] **Step 7: Run tests**

Run:

```bash
bun test packages/core/src/external-agents/config.test.ts packages/core/src/external-agents/manager.test.ts packages/core/src/external-agents/claude-code.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/external-agents
git commit -m "feat(remote): add external agent jobs"
```

---

## Task 3: Add trusted device store and pairing token lifecycle

**Files:**
- Create: `packages/desktop/src/main/mobile-remote/types.ts`
- Create: `packages/desktop/src/main/mobile-remote/trusted-device-store.ts`
- Create: `packages/desktop/src/main/mobile-remote/pairing.ts`
- Test: `packages/desktop/src/main/mobile-remote/trusted-device-store.test.ts`
- Test: `packages/desktop/src/main/mobile-remote/pairing.test.ts`

- [ ] **Step 1: Write trusted-device store test**

Create `packages/desktop/src/main/mobile-remote/trusted-device-store.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { TrustedDeviceStore } from "./trusted-device-store.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("TrustedDeviceStore", () => {
  test("adds, lists, authenticates, and revokes devices", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    const created = store.addDevice({ name: "iPhone", secretHash: "hash1" });

    expect(store.listDevices()).toHaveLength(1);
    expect(store.authenticate(created.id, "hash1")?.name).toBe("iPhone");

    store.revoke(created.id);
    expect(store.authenticate(created.id, "hash1")).toBeUndefined();
    expect(store.listDevices()[0]?.revokedAt).toBeNumber();
  });
});
```

- [ ] **Step 2: Write pairing test**

Create `packages/desktop/src/main/mobile-remote/pairing.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PairingTokenManager } from "./pairing.js";

describe("PairingTokenManager", () => {
  test("creates one-use token", () => {
    const mgr = new PairingTokenManager(() => 1000);
    const token = mgr.createToken(10_000);
    expect(mgr.consume(token.value)).toBe(true);
    expect(mgr.consume(token.value)).toBe(false);
  });

  test("rejects expired token", () => {
    let now = 1000;
    const mgr = new PairingTokenManager(() => now);
    const token = mgr.createToken(10);
    now = 2000;
    expect(mgr.consume(token.value)).toBe(false);
  });
});
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
bun test packages/desktop/src/main/mobile-remote/trusted-device-store.test.ts packages/desktop/src/main/mobile-remote/pairing.test.ts
```

Expected: FAIL because implementation files do not exist.

- [ ] **Step 4: Add mobile remote types**

Create `packages/desktop/src/main/mobile-remote/types.ts`:

```ts
export interface TrustedDevice {
  id: string;
  name: string;
  secretHash: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface TrustedDevicePublic {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface PairingToken {
  value: string;
  expiresAt: number;
}
```

- [ ] **Step 5: Implement store and pairing**

Create `packages/desktop/src/main/mobile-remote/trusted-device-store.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { TrustedDevice, TrustedDevicePublic } from "./types.js";

export class TrustedDeviceStore {
  constructor(private readonly filePath: string) {}

  addDevice(input: { name: string; secretHash: string }): TrustedDevicePublic {
    const devices = this.readAll();
    const device: TrustedDevice = {
      id: randomUUID(),
      name: input.name,
      secretHash: input.secretHash,
      createdAt: Date.now(),
    };
    devices.push(device);
    this.writeAll(devices);
    return this.toPublic(device);
  }

  listDevices(): TrustedDevicePublic[] {
    return this.readAll().map((device) => this.toPublic(device));
  }

  authenticate(id: string, secretHash: string): TrustedDevicePublic | undefined {
    const devices = this.readAll();
    const device = devices.find((item) => item.id === id && item.secretHash === secretHash && !item.revokedAt);
    if (!device) return undefined;
    device.lastSeenAt = Date.now();
    this.writeAll(devices);
    return this.toPublic(device);
  }

  revoke(id: string): boolean {
    const devices = this.readAll();
    const device = devices.find((item) => item.id === id && !item.revokedAt);
    if (!device) return false;
    device.revokedAt = Date.now();
    this.writeAll(devices);
    return true;
  }

  private readAll(): TrustedDevice[] {
    if (!existsSync(this.filePath)) return [];
    return JSON.parse(readFileSync(this.filePath, "utf-8")) as TrustedDevice[];
  }

  private writeAll(devices: TrustedDevice[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(devices, null, 2), "utf-8");
  }

  private toPublic(device: TrustedDevice): TrustedDevicePublic {
    return {
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt,
    };
  }
}
```

Create `packages/desktop/src/main/mobile-remote/pairing.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { PairingToken } from "./types.js";

export class PairingTokenManager {
  private tokens = new Map<string, PairingToken>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  createToken(ttlMs = 10 * 60 * 1000): PairingToken {
    const token = { value: randomBytes(32).toString("base64url"), expiresAt: this.now() + ttlMs };
    this.tokens.set(token.value, token);
    return token;
  }

  consume(value: string): boolean {
    const token = this.tokens.get(value);
    if (!token) return false;
    this.tokens.delete(value);
    return token.expiresAt >= this.now();
  }
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun test packages/desktop/src/main/mobile-remote/trusted-device-store.test.ts packages/desktop/src/main/mobile-remote/pairing.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/main/mobile-remote
git commit -m "feat(remote): add trusted device pairing"
```

---

## Task 4: Add RemoteHostManager HTTP/WebSocket shell

**Files:**
- Modify: `packages/desktop/package.json`
- Create: `packages/desktop/src/main/mobile-remote/mobile-ui.ts`
- Create: `packages/desktop/src/main/mobile-remote/remote-host-manager.ts`
- Test: `packages/desktop/src/main/mobile-remote/remote-host-manager.test.ts`

- [ ] **Step 1: Add dependency**

Run:

```bash
bun add --cwd packages/desktop ws
bun add --cwd packages/desktop -d @types/ws
```

Expected: `packages/desktop/package.json` and lockfile update.

- [ ] **Step 2: Write remote host tests**

Create `packages/desktop/src/main/mobile-remote/remote-host-manager.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RemoteHostManager } from "./remote-host-manager.js";
import { TrustedDeviceStore } from "./trusted-device-store.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("RemoteHostManager", () => {
  test("starts, serves mobile HTML, and stops", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    expect(started.url).toStartWith("http://127.0.0.1:");
    const res = await fetch(`${started.url}/mobile`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("CodeShell Mobile Remote");
    await host.stop();
  });

  test("creates pairing URL", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    const pairing = host.createPairingUrl();
    expect(pairing.url).toContain(`${started.url}/mobile?pairing=`);
    await host.stop();
  });
});
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
bun test packages/desktop/src/main/mobile-remote/remote-host-manager.test.ts
```

Expected: FAIL because `remote-host-manager.ts` and `mobile-ui.ts` do not exist.

- [ ] **Step 4: Add minimal mobile UI HTML**

Create `packages/desktop/src/main/mobile-remote/mobile-ui.ts`:

```ts
export function mobileRemoteHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeShell Mobile Remote</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #0b0f17; color: #e5e7eb; }
    main { max-width: 720px; margin: 0 auto; padding: 20px; }
    textarea { width: 100%; min-height: 96px; border-radius: 12px; border: 1px solid #374151; background: #111827; color: #fff; padding: 12px; }
    button { border: 0; border-radius: 999px; background: #60a5fa; color: #06111f; padding: 10px 16px; font-weight: 700; }
    pre { white-space: pre-wrap; background: #111827; border-radius: 12px; padding: 12px; }
    .danger { color: #fca5a5; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>CodeShell Mobile Remote</h1>
    <p id="status">Connecting...</p>
    <textarea id="input" placeholder="Send a CodeShell task, /cc task, or /codex task"></textarea>
    <p><button id="send">Send</button></p>
    <pre id="log"></pre>
  </main>
  <script>
    const log = document.getElementById('log');
    const status = document.getElementById('status');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const wsUrl = location.origin.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => { status.textContent = 'Connected'; ws.send(JSON.stringify({ type: 'hello.mobile' })); };
    ws.onmessage = (event) => { log.textContent += event.data + '\n'; };
    ws.onclose = () => { status.textContent = 'Disconnected'; };
    send.onclick = () => { ws.send(JSON.stringify({ type: 'chat.send', text: input.value })); input.value = ''; };
  </script>
</body>
</html>`;
}
```

- [ ] **Step 5: Implement RemoteHostManager**

Create `packages/desktop/src/main/mobile-remote/remote-host-manager.ts`:

```ts
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { mobileRemoteHtml } from "./mobile-ui.js";
import { PairingTokenManager } from "./pairing.js";
import type { TrustedDeviceStore } from "./trusted-device-store.js";

export interface RemoteHostStartOptions {
  host: string;
  port: number;
}

export interface RemoteHostStarted {
  host: string;
  port: number;
  url: string;
}

export interface RemoteHostManagerOptions {
  devices: TrustedDeviceStore;
  onClientEvent: (event: unknown, ws: WebSocket) => void;
}

export class RemoteHostManager {
  private server?: Server;
  private wss?: WebSocketServer;
  private started?: RemoteHostStarted;
  private pairing = new PairingTokenManager();

  constructor(private readonly opts: RemoteHostManagerOptions) {}

  async start(options: RemoteHostStartOptions): Promise<RemoteHostStarted> {
    if (this.started) return this.started;
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/mobile")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(mobileRemoteHtml());
        return;
      }
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        try {
          this.opts.onClientEvent(JSON.parse(String(raw)), ws);
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : options.port;
    this.started = { host: options.host, port, url: `http://${options.host}:${port}` };
    return this.started;
  }

  createPairingUrl(): { token: string; url: string; expiresAt: number } {
    if (!this.started) throw new Error("Remote host is not running");
    const token = this.pairing.createToken();
    return { token: token.value, expiresAt: token.expiresAt, url: `${this.started.url}/mobile?pairing=${token.value}` };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.wss?.close();
    this.wss = undefined;
    this.server = undefined;
    this.started = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  status(): RemoteHostStarted | undefined {
    return this.started;
  }
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun test packages/desktop/src/main/mobile-remote/remote-host-manager.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/package.json bun.lock packages/desktop/src/main/mobile-remote/mobile-ui.ts packages/desktop/src/main/mobile-remote/remote-host-manager.ts packages/desktop/src/main/mobile-remote/remote-host-manager.test.ts
git commit -m "feat(remote): add mobile remote host"
```

---

## Task 5: Wire Electron IPC and settings UI controls

**Files:**
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/types.d.ts`
- Modify: `packages/desktop/src/renderer/settings/AdvancedSections.tsx`
- Test: `packages/desktop/src/preload/rpc-timeout.test.ts` if affected

- [ ] **Step 1: Add preload API types**

In `packages/desktop/src/preload/types.d.ts`, add a `mobileRemote` API to the exposed desktop API type:

```ts
mobileRemote: {
  start(): Promise<{ url: string; pairingUrl: string; expiresAt: number }>;
  stop(): Promise<void>;
  status(): Promise<{ running: boolean; url?: string }>;
  listDevices(): Promise<Array<{ id: string; name: string; createdAt: number; lastSeenAt?: number; revokedAt?: number }>>;
  revokeDevice(id: string): Promise<boolean>;
};
```

- [ ] **Step 2: Expose preload bridge methods**

In `packages/desktop/src/preload/index.ts`, add methods using the existing IPC invoke helper pattern:

```ts
mobileRemote: {
  start: () => invoke("mobileRemote:start"),
  stop: () => invoke("mobileRemote:stop"),
  status: () => invoke("mobileRemote:status"),
  listDevices: () => invoke("mobileRemote:listDevices"),
  revokeDevice: (id: string) => invoke("mobileRemote:revokeDevice", id),
},
```

Use the actual local helper name in `preload/index.ts` if it is not named `invoke`.

- [ ] **Step 3: Register IPC handlers in main**

In `packages/desktop/src/main/index.ts`, create the store and manager near other singleton services:

```ts
import { join } from "node:path";
import { app, ipcMain } from "electron";
import { RemoteHostManager } from "./mobile-remote/remote-host-manager.js";
import { TrustedDeviceStore } from "./mobile-remote/trusted-device-store.js";

const mobileDevices = new TrustedDeviceStore(join(app.getPath("userData"), "mobile-remote", "devices.json"));
const mobileRemote = new RemoteHostManager({
  devices: mobileDevices,
  onClientEvent: (event, ws) => {
    ws.send(JSON.stringify({ type: "echo", event }));
  },
});
```

Register IPC handlers after other handlers:

```ts
ipcMain.handle("mobileRemote:start", async () => {
  const started = await mobileRemote.start({ host: "127.0.0.1", port: 0 });
  const pairing = mobileRemote.createPairingUrl();
  return { url: started.url, pairingUrl: pairing.url, expiresAt: pairing.expiresAt };
});

ipcMain.handle("mobileRemote:stop", async () => {
  await mobileRemote.stop();
});

ipcMain.handle("mobileRemote:status", async () => {
  const status = mobileRemote.status();
  return { running: Boolean(status), url: status?.url };
});

ipcMain.handle("mobileRemote:listDevices", async () => mobileDevices.listDevices());

ipcMain.handle("mobileRemote:revokeDevice", async (_event, id: string) => mobileDevices.revoke(id));
```

At shutdown, call:

```ts
void mobileRemote.stop();
```

- [ ] **Step 4: Add settings UI section**

In `packages/desktop/src/renderer/settings/AdvancedSections.tsx`, add a `MobileRemoteSection` component and render it in the advanced settings page:

```tsx
function MobileRemoteSection() {
  const [status, setStatus] = React.useState<{ running: boolean; url?: string }>({ running: false });
  const [pairingUrl, setPairingUrl] = React.useState<string | undefined>();
  const [devices, setDevices] = React.useState<Array<{ id: string; name: string; createdAt: number; revokedAt?: number }>>([]);

  async function refresh() {
    setStatus(await window.codeShell.mobileRemote.status());
    setDevices(await window.codeShell.mobileRemote.listDevices());
  }

  React.useEffect(() => {
    void refresh();
  }, []);

  async function start() {
    const res = await window.codeShell.mobileRemote.start();
    setPairingUrl(res.pairingUrl);
    await refresh();
  }

  async function stop() {
    await window.codeShell.mobileRemote.stop();
    setPairingUrl(undefined);
    await refresh();
  }

  return (
    <section className="rounded-lg border border-border p-4 space-y-3">
      <div>
        <h3 className="font-semibold">Mobile Remote</h3>
        <p className="text-sm text-muted-foreground">Start a local web remote for trusted phones. No public relay.</p>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={start}>Start mobile remote</button>
        <button type="button" onClick={stop} disabled={!status.running}>Stop</button>
      </div>
      {status.running ? <p className="text-sm">Running at {status.url}</p> : <p className="text-sm">Stopped</p>}
      {pairingUrl ? <pre className="text-xs whitespace-pre-wrap">{pairingUrl}</pre> : null}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Trusted devices</h4>
        {devices.length === 0 ? <p className="text-sm text-muted-foreground">No trusted devices.</p> : null}
        {devices.map((device) => (
          <div key={device.id} className="flex items-center justify-between text-sm">
            <span>{device.name}{device.revokedAt ? " (revoked)" : ""}</span>
            {!device.revokedAt ? (
              <button type="button" onClick={async () => { await window.codeShell.mobileRemote.revokeDevice(device.id); await refresh(); }}>
                Revoke
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
```

Use existing project button/card classes if this file already has local UI helpers.

- [ ] **Step 5: Typecheck desktop package**

Run:

```bash
bun run --filter '@cjhyy/code-shell-desktop' typecheck
```

Expected: no new errors from mobile remote files. If repo has pre-existing typecheck errors, record them and verify none point to files modified in this task.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/index.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts packages/desktop/src/renderer/settings/AdvancedSections.tsx
git commit -m "feat(remote): wire mobile remote controls"
```

---

## Task 6: Add mobile WebSocket auth, chat, and approval routing

**Files:**
- Modify: `packages/desktop/src/main/mobile-remote/remote-host-manager.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/mobile-remote/types.ts`
- Test: `packages/desktop/src/main/mobile-remote/remote-host-manager.test.ts`

- [ ] **Step 1: Extend protocol types**

In `packages/desktop/src/main/mobile-remote/types.ts`, add:

```ts
export type MobileClientEvent =
  | { type: "auth.device"; deviceId: string; secretHash: string }
  | { type: "pair.complete"; token: string; name: string; secretHash: string }
  | { type: "chat.send"; text: string; sessionId?: string }
  | { type: "run.stop"; sessionId: string }
  | { type: "approval.respond"; approvalId: string; decision: "approve" | "reject" }
  | { type: "job.stop"; jobId: string };

export type MobileServerEvent =
  | { type: "auth.ok"; device: TrustedDevicePublic }
  | { type: "auth.failed"; message: string }
  | { type: "pair.ok"; device: TrustedDevicePublic }
  | { type: "pair.failed"; message: string }
  | { type: "chat.accepted"; sessionId?: string }
  | { type: "approval.request"; approvalId: string; title: string; risk: "low" | "medium" | "high"; body: string }
  | { type: "error"; message: string };
```

- [ ] **Step 2: Add auth test**

Append to `remote-host-manager.test.ts`:

```ts
test("pairs and authenticates a device over client events", async () => {
  dir = mkdtempSync(join(tmpdir(), "remote-host-"));
  const seen: unknown[] = [];
  const host = new RemoteHostManager({
    devices: new TrustedDeviceStore(join(dir, "devices.json")),
    onClientEvent: (event) => seen.push(event),
  });
  await host.start({ host: "127.0.0.1", port: 0 });
  const pairing = host.createPairingUrl();

  const paired = host.handleClientEvent({ type: "pair.complete", token: pairing.token, name: "iPhone", secretHash: "h1" });
  expect(paired.type).toBe("pair.ok");
  const device = paired.type === "pair.ok" ? paired.device : undefined;
  expect(device?.name).toBe("iPhone");

  const authed = host.handleClientEvent({ type: "auth.device", deviceId: device!.id, secretHash: "h1" });
  expect(authed.type).toBe("auth.ok");
  await host.stop();
});
```

- [ ] **Step 3: Implement handleClientEvent**

In `remote-host-manager.ts`, add a method:

```ts
handleClientEvent(event: MobileClientEvent): MobileServerEvent | undefined {
  if (event.type === "pair.complete") {
    if (!this.pairing.consume(event.token)) return { type: "pair.failed", message: "Pairing token expired or invalid" };
    const device = this.opts.devices.addDevice({ name: event.name, secretHash: event.secretHash });
    return { type: "pair.ok", device };
  }
  if (event.type === "auth.device") {
    const device = this.opts.devices.authenticate(event.deviceId, event.secretHash);
    if (!device) return { type: "auth.failed", message: "Device is not trusted" };
    return { type: "auth.ok", device };
  }
  this.opts.onClientEvent(event, undefined as never);
  return undefined;
}
```

Update the WebSocket message handler to call `handleClientEvent` and send any returned event:

```ts
const reply = this.handleClientEvent(JSON.parse(String(raw)) as MobileClientEvent);
if (reply) ws.send(JSON.stringify(reply));
```

- [ ] **Step 4: Route chat events to desktop agent bridge**

In `packages/desktop/src/main/index.ts`, replace the echo `onClientEvent` with a dispatcher that handles:

```ts
if (event.type === "chat.send") {
  // Use the same internal send-message path as the renderer chat input.
  // If that path is encapsulated in agent-bridge.ts, expose a small function there and call it here.
}
```

The exact call must reuse the existing desktop chat/session send implementation. Do not create a second run loop.

- [ ] **Step 5: Route approval responses**

In `packages/desktop/src/main/index.ts`, handle:

```ts
if (event.type === "approval.respond") {
  // Call the same approval resolution path used by desktop approval UI.
}
```

The approval ID and decision must enter the existing RunManager/approval backend path, not bypass tool permissions.

- [ ] **Step 6: Run tests**

Run:

```bash
bun test packages/desktop/src/main/mobile-remote/remote-host-manager.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/main/mobile-remote packages/desktop/src/main/index.ts
git commit -m "feat(remote): add mobile auth and routing"
```

---

## Task 7: Add slash-command parsing and Claude/Codex job start

**Files:**
- Create: `packages/core/src/external-agents/slash.ts`
- Test: `packages/core/src/external-agents/slash.test.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/mobile-remote/mobile-ui.ts`

- [ ] **Step 1: Write slash parser tests**

Create `packages/core/src/external-agents/slash.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseExternalAgentSlash } from "./slash.js";

describe("parseExternalAgentSlash", () => {
  test("parses /cc prompt", () => {
    expect(parseExternalAgentSlash("/cc fix tests")).toEqual({ kind: "claude-code", prompt: "fix tests", mode: undefined });
  });

  test("parses /cc --safe prompt", () => {
    expect(parseExternalAgentSlash("/cc --safe fix tests")).toEqual({ kind: "claude-code", prompt: "fix tests", mode: "safe" });
  });

  test("parses /cc --dangerous prompt", () => {
    expect(parseExternalAgentSlash("/cc --dangerous fix tests")).toEqual({ kind: "claude-code", prompt: "fix tests", mode: "dangerous" });
  });

  test("parses /codex prompt", () => {
    expect(parseExternalAgentSlash("/codex review diff")).toEqual({ kind: "codex", prompt: "review diff", mode: undefined });
  });

  test("returns undefined for normal chat", () => {
    expect(parseExternalAgentSlash("hello")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement slash parser**

Create `packages/core/src/external-agents/slash.ts`:

```ts
import type { ExternalAgentKind, ExternalAgentModeOverride } from "./types.js";

export interface ParsedExternalAgentSlash {
  kind: ExternalAgentKind;
  prompt: string;
  mode: ExternalAgentModeOverride;
}

export function parseExternalAgentSlash(input: string): ParsedExternalAgentSlash | undefined {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/(cc|codex)\s+(.+)$/s);
  if (!match) return undefined;
  const kind: ExternalAgentKind = match[1] === "cc" ? "claude-code" : "codex";
  let body = match[2]!.trim();
  let mode: ExternalAgentModeOverride;
  if (body.startsWith("--safe ")) {
    mode = "safe";
    body = body.slice("--safe ".length).trim();
  } else if (body.startsWith("--dangerous ")) {
    mode = "dangerous";
    body = body.slice("--dangerous ".length).trim();
  }
  if (!body) return undefined;
  return { kind, prompt: body, mode };
}
```

- [ ] **Step 3: Run slash tests**

Run:

```bash
bun test packages/core/src/external-agents/slash.test.ts
```

Expected: PASS.

- [ ] **Step 4: Wire slash parser in mobile chat path**

In the mobile `chat.send` handler created in Task 6:

```ts
const parsed = parseExternalAgentSlash(event.text);
if (parsed?.kind === "claude-code") {
  const cfg = resolveExternalAgentConfig(settings.externalAgents).claudeCode;
  const decision = resolveClaudeModeForWorkspace(cfg, currentCwd, parsed.mode);
  if (decision.requiresHighRiskApproval) {
    // emit approval.request to mobile with title "Start Claude Code dangerous job?"
    // resume path starts manager after approve
    return;
  }
  externalAgentJobs.start({
    kind: "claude-code",
    sessionId: event.sessionId ?? activeSessionId,
    cwd: currentCwd,
    prompt: parsed.prompt,
    command: cfg.command,
    mode: decision.mode,
    args: decision.args,
  });
  return;
}
```

For `/codex`, use resolved codex command/args and mode `safe`.

- [ ] **Step 5: Update mobile UI hint**

In `mobile-ui.ts`, ensure placeholder text says:

```html
<textarea id="input" placeholder="Send a task, /cc task, /cc --safe task, /cc --dangerous task, or /codex task"></textarea>
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun test packages/core/src/external-agents/slash.test.ts packages/core/src/external-agents/config.test.ts packages/core/src/external-agents/manager.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/external-agents packages/desktop/src/main/index.ts packages/desktop/src/main/mobile-remote/mobile-ui.ts
git commit -m "feat(remote): add external agent slash commands"
```

---

## Task 8: End-to-end verification and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-06-06-mobile-remote-control-design.md` if implementation changes the contract.
- Create: `docs/mobile-remote-smoke.md`

- [ ] **Step 1: Add smoke test doc**

Create `docs/mobile-remote-smoke.md`:

```md
# Mobile Remote Smoke Test

## Preconditions

- CodeShell Electron is running.
- The phone is on the same LAN as the Mac, or the user has a self-managed tunnel.
- For `/cc`, Claude Code CLI is installed and logged in.
- For `/codex`, Codex CLI is installed and logged in.

## Steps

1. Open Electron Settings → Advanced → Mobile Remote.
2. Click "Start mobile remote".
3. Open the pairing URL on a phone browser.
4. Pair the device.
5. Send a normal chat message and confirm streaming response appears.
6. Send `/cc --safe echo a short status about this repo`.
7. Confirm a Claude Code job card appears.
8. Send `/cc --dangerous inspect the repo and summarize the package scripts` from a non-trusted workspace and confirm high-risk approval appears.
9. Configure the current workspace as trusted with `defaultMode: dangerous` and `autoStartInTrustedWorkspaces: true`.
10. Send `/cc inspect the repo and summarize the package scripts` and confirm it starts with a dangerous badge.
11. Revoke the phone device in Electron settings.
12. Refresh the phone page and confirm it cannot reconnect.

## Expected result

The phone can control CodeShell chat, launch external agent jobs, approve required actions, and cannot reconnect after revocation.
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
bun test packages/core/src/external-agents/config.test.ts packages/core/src/external-agents/manager.test.ts packages/core/src/external-agents/claude-code.test.ts packages/core/src/external-agents/slash.test.ts packages/desktop/src/main/mobile-remote/trusted-device-store.test.ts packages/desktop/src/main/mobile-remote/pairing.test.ts packages/desktop/src/main/mobile-remote/remote-host-manager.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run desktop typecheck**

Run:

```bash
bun run --filter '@cjhyy/code-shell-desktop' typecheck
```

Expected: no errors in mobile remote or external-agent files. If pre-existing errors appear elsewhere, record them in the final summary with file paths.

- [ ] **Step 4: Run build if typecheck is clean enough**

Run:

```bash
bun run --filter '@cjhyy/code-shell-desktop' build
```

Expected: Electron desktop package builds. If build fails because of unrelated pre-existing issues, record the failure and verify no error points to files changed in this plan.

- [ ] **Step 5: Commit docs and verification fixes**

```bash
git add docs/mobile-remote-smoke.md docs/superpowers/specs/2026-06-06-mobile-remote-control-design.md
git commit -m "docs: add mobile remote smoke test"
```

If the spec did not change and only the smoke doc was created, commit only `docs/mobile-remote-smoke.md`.

---

## Self-review

### Spec coverage

- Electron starts a local Mobile Web Remote: Tasks 4 and 5.
- Web/PWA rather than native App: Task 4 mobile static UI and Task 8 smoke doc.
- Trusted device pairing and revoke: Task 3 and Task 5.
- Phone approval equal to desktop approval: Task 6 routing requirement.
- Low-risk auto allow: Task 6 sets the routing point; implementer must wire to existing permission backend rather than bypassing it.
- Claude/Codex managed jobs: Tasks 1, 2, and 7.
- Project-default Claude Code dangerous mode: Tasks 1 and 7.
- Dangerous mode trusted workspace allowlist and audit: Tasks 1, 6, 7, and Task 8 smoke.
- No public relay: Task 5 host binding and Task 8 docs.

### Placeholder scan

The plan contains no placeholder markers, no unspecified test commands, and no steps that ask the implementer to invent behavior without a concrete target. The only integration-sensitive points are desktop chat/approval routing in Task 6; the plan explicitly requires reusing the existing desktop run and approval path rather than creating a second run loop.

### Type consistency

The types introduced in Task 1 and extended in Task 2 are used consistently by the slash parser and adapters:

- `ExternalAgentKind`: `"claude-code" | "codex"`
- `ExternalAgentMode`: `"safe" | "dangerous"`
- `ExternalAgentJob.status`: `"queued" | "running" | "completed" | "failed" | "killed"`
- Mobile protocol event names are stable across Tasks 4-7.
