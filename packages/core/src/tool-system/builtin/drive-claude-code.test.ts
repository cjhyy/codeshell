import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  driveClaudeCodeToolDef,
  makeDriveClaudeCodeTool,
  driveAgentToolDef,
  makeDriveAgentTool,
  driveAgentJobsToolDef,
  driveAgentJobsTool,
} from "./drive-claude-code.js";
import { backgroundJobRegistry, type BackgroundJobEntry } from "./background-jobs.js";
import { agentNotificationBus, notificationQueue } from "./agent-notifications.js";
import { makeDriveClaudeCodeTool as mkBg } from "./drive-claude-code.js";
import { ExternalAgentSessionStore } from "../../cc-orchestrator/external-agent-session-store.js";
import { BUILTIN_TOOLS } from "./index.js";

function legacyDriveJobListLine(job: BackgroundJobEntry): string {
  const files = job.changedFiles ?? [];
  const changedFiles =
    files.length === 0
      ? "unknown"
      : files.length <= 4
        ? files.join(",")
        : `${files.slice(0, 4).join(",")} (+${files.length - 4} more)`;
  const end = job.finishedAt ?? Date.now();
  const duration = `${Math.max(0, (end - job.startedAt) / 1000).toFixed(1)}s`;
  const prompt = job.promptSummary || job.description || "(no prompt summary)";
  return [
    job.jobId,
    `status=${job.status}`,
    `cli=${job.cli ?? "unknown"}`,
    `session=${job.sessionId}`,
    `launchCwd=${job.launchCwd ?? job.cwd ?? "(unknown cwd)"}`,
    `startedAt=${new Date(job.startedAt).toISOString()}`,
    `duration=${duration}`,
    `changedFiles=${changedFiles}`,
    `prompt="${prompt}"`,
  ].join("  ");
}

describe("DriveAgent tool", () => {
  it("has a name and an inputSchema with prompt + background + cli", () => {
    expect(driveAgentToolDef.name).toBe("DriveAgent");
    expect((driveAgentToolDef.inputSchema as any).properties.prompt).toBeDefined();
    expect((driveAgentToolDef.inputSchema as any).properties.background).toBeDefined();
    expect((driveAgentToolDef.inputSchema as any).properties.model).toBeDefined();
    expect((driveAgentToolDef.inputSchema as any).properties.effectiveWorkspaceCwd).toBeDefined();
    expect((driveAgentToolDef.inputSchema as any).properties.cli.enum).toEqual(["claude", "codex"]);
  });

  it("passes only an explicitly provided non-empty model to the runner", async () => {
    const seen: Array<string | undefined> = [];
    const tool = makeDriveAgentTool(async (o) => {
      seen.push(o.model);
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "p", cwd: "/x", background: false, model: "codex-x" } as any);
    await tool({ prompt: "p", cwd: "/x", background: false } as any);
    await tool({ prompt: "p", cwd: "/x", background: false, model: "   " } as any);
    expect(seen).toEqual(["codex-x", undefined, undefined]);
  });

  it("routes cli:'codex' to the codex runner, defaults (omitted) to claude", async () => {
    const seen: string[] = [];
    const tool = makeDriveAgentTool(async (o) => {
      seen.push(o.cli);
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "p", cwd: "/x", background: false, cli: "codex" } as any);
    await tool({ prompt: "p", cwd: "/x", background: false } as any);
    expect(seen).toEqual(["codex", "claude"]);
  });

  it("passes only an explicitly provided non-empty model to the runner", async () => {
    const seen: Array<string | undefined> = [];
    const tool = makeDriveAgentTool(async (o) => {
      seen.push(o.model);
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "p", cwd: "/x", background: false, model: "codex-x" } as any);
    await tool({ prompt: "p", cwd: "/x", background: false } as any);
    await tool({ prompt: "p", cwd: "/x", background: false, model: "   " } as any);
    expect(seen).toEqual(["codex-x", undefined, undefined]);
  });

  it("rejects an unknown cli value", async () => {
    const tool = makeDriveAgentTool(async () => ({
      sessionId: "S",
      finalText: "x",
      isError: false,
      exitCode: 0,
      lines: [],
    }));
    const out = await tool({ prompt: "p", cwd: "/x", background: false, cli: "gpt" } as any);
    expect(out.toLowerCase()).toContain("cli");
  });

  it("registers DriveAgent and DriveClaudeCode with explicit long timeouts", () => {
    const drive = BUILTIN_TOOLS.find((t) => t.definition.name === "DriveAgent")?.definition;
    const alias = BUILTIN_TOOLS.find((t) => t.definition.name === "DriveClaudeCode")?.definition;
    const jobs = BUILTIN_TOOLS.find((t) => t.definition.name === "DriveAgentJobs")?.definition;
    expect(drive?.timeoutMs).toBeGreaterThan(120_000);
    expect(alias?.timeoutMs).toBe(drive?.timeoutMs);
    expect(jobs?.name).toBe("DriveAgentJobs");
  });

  it("propagates the ToolContext AbortSignal to the runner", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const tool = makeDriveAgentTool(async (o) => {
      seen = o.signal;
      controller.abort();
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool(
      { prompt: "p", cwd: "/x", background: false } as any,
      { cwd: "/x", sessionId: "S-CTX", signal: controller.signal } as any,
    );
    expect(seen?.aborted).toBe(true);
  });

  it("appends attachment paths to the driven prompt and passes Codex image paths", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-attachments-"));
    try {
      const image = join(tmp, "shot.png");
      const text = join(tmp, "notes.txt");
      writeFileSync(image, "png");
      writeFileSync(text, "notes");
      let seenPrompt = "";
      let seenImages: string[] | undefined;
      const tool = makeDriveAgentTool(async (o) => {
        seenPrompt = o.prompt;
        seenImages = o.imagePaths;
        return { sessionId: "S", finalText: "ok", isError: false, exitCode: 0, lines: [] };
      });
      await tool(
        {
          prompt: "inspect",
          cwd: tmp,
          background: false,
          cli: "codex",
          attachmentPaths: ["shot.png", "notes.txt"],
        } as any,
        { cwd: tmp, sessionId: "S-CTX" } as any,
      );
      expect(seenPrompt).toContain("Attached files:");
      expect(seenPrompt).toContain(realpathSync(image));
      expect(seenPrompt).toContain(realpathSync(text));
      expect(seenImages).toEqual([realpathSync(image)]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects attachment paths outside cwd before launching the runner", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-attachments-cwd-"));
    const outside = mkdtempSync(join(tmpdir(), "drive-attachments-out-"));
    try {
      const image = join(outside, "shot.png");
      writeFileSync(image, "png");
      let ran = false;
      const tool = makeDriveAgentTool(async () => {
        ran = true;
        return { sessionId: "S", finalText: "ok", isError: false, exitCode: 0, lines: [] };
      });
      const out = await tool(
        { prompt: "inspect", cwd: tmp, background: false, attachmentPaths: [image] } as any,
        { cwd: tmp, sessionId: "S-CTX" } as any,
      );
      expect(out).toContain("outside cwd");
      expect(ran).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("propagates the registry-injected __signal when ToolContext is absent", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const tool = makeDriveAgentTool(async (o) => {
      seen = o.signal;
      controller.abort();
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "p", cwd: "/x", background: false, __signal: controller.signal } as any);
    expect(seen?.aborted).toBe(true);
  });
});

describe("DriveClaudeCode alias (back-compat)", () => {
  it("has a name and an inputSchema with prompt + background", () => {
    expect(driveClaudeCodeToolDef.name).toBe("DriveClaudeCode");
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.prompt).toBeDefined();
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.background).toBeDefined();
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.model).toBeDefined();
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.cli).toBeUndefined();
  });

  it("passes model through the legacy claude runner adapter", async () => {
    let seen: string | undefined;
    const tool = makeDriveClaudeCodeTool(async (o) => {
      seen = o.model;
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "p", cwd: "/x", background: false, model: "claude-x" } as any);
    expect(seen).toBe("claude-x");
  });

  // CC tasks are typically long (minutes → hours), so the tool runs in the
  // BACKGROUND by default: it returns immediately and the result is delivered
  // on completion via a wakeup notification. A caller wanting the answer inline
  // for a quick task passes background:false.
  it("defaults to background: returns immediately, registers a job, does NOT block", async () => {
    backgroundJobRegistry.reset?.();
    let resolveRun!: (r: any) => void;
    const runner = () =>
      new Promise<any>((res) => {
        resolveRun = res;
      });
    const tool = mkBg(runner as any);
    const out = await tool({ prompt: "long research", cwd: "/x" }, {
      cwd: "/x",
      sessionId: "S-DEF",
    } as any);
    expect(out).toContain("后台");
    expect(backgroundJobRegistry.hasRunningForSession("S-DEF")).toBe(true);
    resolveRun({ sessionId: "CC1", finalText: "done", isError: false, exitCode: 0, lines: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(backgroundJobRegistry.hasRunningForSession("S-DEF")).toBe(false);
  });

  it("fails loud (no job started) when background but ctx has no sessionId — result would be dropped", async () => {
    backgroundJobRegistry.reset?.();
    let ran = false;
    const runner = async () => {
      ran = true;
      return { sessionId: "X", finalText: "", isError: false, exitCode: 0, lines: [] };
    };
    const tool = mkBg(runner as any);
    // background (default) + ctx without sessionId
    const out = await tool({ prompt: "p", cwd: "/x" }, { cwd: "/x" } as any);
    expect(out.toLowerCase()).toContain("error");
    expect(out).toContain("session");
    expect(ran).toBe(false); // runner never launched
    // No orphaned running job left behind.
    expect(backgroundJobRegistry.hasRunningForSession("")).toBe(false);
  });

  it("background:false runs in the foreground and returns the result inline", async () => {
    const tool = makeDriveClaudeCodeTool(async () => ({
      sessionId: "S7",
      finalText: "did it",
      isError: false,
      exitCode: 0,
      lines: [],
    }));
    const out = await tool({ prompt: "go", cwd: "/x", background: false } as any);
    expect(out).toContain("S7");
    expect(out).toContain("did it");
  });

  it("defaults to bypassPermissions so headless tools (WebSearch/WebFetch/Write) aren't blocked", async () => {
    let seen: string | undefined;
    const tool = makeDriveClaudeCodeTool(async (o) => {
      seen = o.permissionMode;
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "search the web", cwd: "/x", background: false } as any);
    expect(seen).toBe("bypassPermissions");
  });

  it("still honors an explicit permissionMode from the caller", async () => {
    let seen: string | undefined;
    const tool = makeDriveClaudeCodeTool(async (o) => {
      seen = o.permissionMode;
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({
      prompt: "edit code",
      cwd: "/x",
      background: false,
      permissionMode: "default",
    } as any);
    expect(seen).toBe("default");
  });

  it("background:false auto-hands off to a tracked background job after the foreground threshold", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.drainAll("S-HANDOFF");
    const tmp = mkdtempSync(join(tmpdir(), "drive-handoff-"));
    try {
      let resolveRun!: (r: any) => void;
      let runCount = 0;
      const runner = () => {
        runCount++;
        return new Promise<any>((res) => {
          resolveRun = res;
        });
      };
      const store = new ExternalAgentSessionStore(join(tmp, "sessions.json"));
      const tool = makeDriveClaudeCodeTool(runner as any, {
        foregroundHandoffMs: 5,
        sessionStore: store,
      });

      const out = await tool(
        { prompt: "long but requested foreground", cwd: tmp, background: false } as any,
        { cwd: tmp, sessionId: "S-HANDOFF" } as any,
      );

      expect(out).toContain("jobId");
      expect(out).toContain("background");
      expect(runCount).toBe(1);
      expect(backgroundJobRegistry.hasRunningForSession("S-HANDOFF")).toBe(true);
      const job = backgroundJobRegistry.listRunningForSession("S-HANDOFF")[0];
      const jobId = out.match(/jobId ([^)]+)\)/)?.[1];
      expect(jobId).toBeDefined();
      if (!jobId) throw new Error("expected background job id");
      expect(job).toBeDefined();
      if (!job) throw new Error("expected background job");
      expect(job.jobId).toBe(jobId);
      const jobCwd = job.cwd;
      expect(jobCwd).toBeDefined();
      if (!jobCwd) throw new Error("expected background job cwd");
      expect(jobCwd).toBe(realpathSync(tmp));

      resolveRun({
        sessionId: "CC-HANDOFF",
        finalText: "eventual result",
        isError: false,
        exitCode: 0,
        lines: [],
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(backgroundJobRegistry.hasRunningForSession("S-HANDOFF")).toBe(false);
      const items = notificationQueue.drainAll("S-HANDOFF");
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe("completed");
      expect(items[0].finalText).toContain("eventual result");
      expect(store.get("claude", "CC-HANDOFF")?.cwd).toBe(realpathSync(tmp));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("warns when a new writable background DriveAgent starts in a cwd already used by a running job", async () => {
    backgroundJobRegistry.reset?.();
    const tmp = mkdtempSync(join(tmpdir(), "drive-cwd-"));
    try {
      const never = () => new Promise<any>(() => {});
      const tool = makeDriveClaudeCodeTool(never as any);

      const first = await tool(
        { prompt: "first", cwd: tmp } as any,
        { cwd: tmp, sessionId: "S-CWD" } as any,
      );
      const second = await tool(
        { prompt: "second", cwd: tmp } as any,
        { cwd: tmp, sessionId: "S-CWD" } as any,
      );

      expect(first).not.toContain("Warning");
      expect(second).toContain("Warning");
      expect(second).toContain(realpathSync(tmp));
      expect(second).toContain("DriveAgentJobs");
      expect(second).toContain("first");
      expect(backgroundJobRegistry.listRunningForSession("S-CWD").map((j) => j.cwd)).toEqual([
        realpathSync(tmp),
        realpathSync(tmp),
      ]);
    } finally {
      backgroundJobRegistry.reset?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses a declared effective workspace instead of launch cwd for dispatch conflicts", async () => {
    backgroundJobRegistry.reset?.();
    const tmp = mkdtempSync(join(tmpdir(), "drive-effective-workspace-"));
    try {
      const launchCwd = join(tmp, "launcher");
      const firstWorkspace = join(tmp, "first");
      const secondWorkspace = join(tmp, "second");
      mkdirSync(launchCwd);
      mkdirSync(firstWorkspace);
      mkdirSync(secondWorkspace);
      const never = () => new Promise<any>(() => {});
      const tool = makeDriveAgentTool(never as any);

      const first = await tool(
        { prompt: "first", cwd: launchCwd, effectiveWorkspaceCwd: firstWorkspace } as any,
        { sessionId: "S-EFFECTIVE-FIRST" } as any,
      );
      const second = await tool(
        { prompt: "second", cwd: launchCwd, effectiveWorkspaceCwd: secondWorkspace } as any,
        { sessionId: "S-EFFECTIVE-SECOND" } as any,
      );
      const third = await tool(
        { prompt: "third", cwd: tmp, effectiveWorkspaceCwd: firstWorkspace } as any,
        { sessionId: "S-EFFECTIVE-THIRD" } as any,
      );

      expect(first).not.toContain("Warning");
      expect(second).not.toContain("Warning");
      expect(third).toContain("Warning");
      expect(third).toContain(realpathSync(firstWorkspace));
    } finally {
      backgroundJobRegistry.reset?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("background job registry compares normalized cwd values", () => {
    backgroundJobRegistry.reset?.();
    const tmp = mkdtempSync(join(tmpdir(), "drive-registry-cwd-"));
    try {
      backgroundJobRegistry.start("job-normalized", "S-REGISTRY", "job", { cwd: `${tmp}/` });

      const running = backgroundJobRegistry.listRunningByCwd(tmp);
      expect(running).toHaveLength(1);
      expect(running[0]!.cwd).toBe(realpathSync(tmp));
    } finally {
      backgroundJobRegistry.reset?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("warns for the same running cwd even when one caller uses a relative path with a trailing slash", async () => {
    backgroundJobRegistry.reset?.();
    const tmp = mkdtempSync(join(tmpdir(), "drive-cwd-normalized-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(dirname(tmp));
      const never = () => new Promise<any>(() => {});
      const tool = makeDriveClaudeCodeTool(never as any);
      const relative = `${basename(tmp)}/`;

      const first = await tool(
        { prompt: "first", cwd: relative } as any,
        { cwd: relative, sessionId: "S-CWD-NORM" } as any,
      );
      const second = await tool(
        { prompt: "second", cwd: tmp } as any,
        { cwd: tmp, sessionId: "S-CWD-NORM" } as any,
      );

      expect(first).not.toContain("Warning");
      expect(second).toContain("Warning");
      expect(second).toContain(realpathSync(tmp));
      expect(backgroundJobRegistry.listRunningForSession("S-CWD-NORM").map((j) => j.cwd)).toEqual([
        realpathSync(tmp),
        realpathSync(tmp),
      ]);
    } finally {
      process.chdir(prevCwd);
      backgroundJobRegistry.reset?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resumeSessionId forces the stored cwd when caller passes a different cwd", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-resume-"));
    try {
      const storedCwd = join(tmp, "stored");
      const callerCwd = join(tmp, "caller");
      mkdirSync(storedCwd);
      mkdirSync(callerCwd);
      const store = new ExternalAgentSessionStore(join(tmp, "sessions.json"));
      store.record({ cli: "claude", sessionId: "CC-OLD", cwd: storedCwd });
      let seenCwd = "";
      const tool = makeDriveClaudeCodeTool(
        async (o) => {
          seenCwd = o.cwd;
          return {
            sessionId: "CC-OLD",
            finalText: "continued",
            isError: false,
            exitCode: 0,
            lines: [],
          };
        },
        { sessionStore: store },
      );

      const out = await tool(
        { prompt: "continue", resumeSessionId: "CC-OLD", cwd: callerCwd, background: false } as any,
        { cwd: callerCwd, sessionId: "S-RESUME" } as any,
      );

      expect(seenCwd).toBe(realpathSync(storedCwd));
      expect(out).toContain("stored cwd");
      expect(out).toContain(realpathSync(storedCwd));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resumeSessionId treats relative and absolute cwd spellings of the same directory as equal", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-resume-normalized-"));
    const prevCwd = process.cwd();
    try {
      const storedCwd = join(tmp, "stored");
      mkdirSync(storedCwd);
      process.chdir(tmp);
      const store = new ExternalAgentSessionStore(join(tmp, "sessions.json"));
      store.record({ cli: "claude", sessionId: "CC-SAME", cwd: storedCwd });
      let seenCwd = "";
      const tool = makeDriveClaudeCodeTool(
        async (o) => {
          seenCwd = o.cwd;
          return {
            sessionId: "CC-SAME",
            finalText: "continued",
            isError: false,
            exitCode: 0,
            lines: [],
          };
        },
        { sessionStore: store },
      );

      const out = await tool(
        {
          prompt: "continue",
          resumeSessionId: "CC-SAME",
          cwd: "stored/",
          background: false,
        } as any,
        { cwd: "stored/", sessionId: "S-RESUME" } as any,
      );

      expect(seenCwd).toBe(realpathSync(storedCwd));
      expect(out).not.toContain("ignoring requested cwd");
    } finally {
      process.chdir(prevCwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resumeSessionId errors clearly when the stored cwd no longer exists", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-resume-missing-"));
    try {
      const missingCwd = join(tmp, "deleted");
      const store = new ExternalAgentSessionStore(join(tmp, "sessions.json"));
      store.record({ cli: "claude", sessionId: "CC-GONE", cwd: missingCwd });
      let ran = false;
      const tool = makeDriveClaudeCodeTool(
        async () => {
          ran = true;
          return {
            sessionId: "CC-GONE",
            finalText: "should not run",
            isError: false,
            exitCode: 0,
            lines: [],
          };
        },
        { sessionStore: store },
      );

      const out = await tool(
        { prompt: "continue", resumeSessionId: "CC-GONE", cwd: tmp, background: false } as any,
        { cwd: tmp, sessionId: "S-RESUME" } as any,
      );

      expect(out).toContain("Error");
      expect(out).toContain("stored cwd no longer exists");
      expect(out).toContain(missingCwd);
      expect(ran).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resumeSessionId errors clearly when the stored cwd is now a file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-resume-file-"));
    try {
      const fileCwd = join(tmp, "not-a-dir");
      writeFileSync(fileCwd, "not a directory");
      const store = new ExternalAgentSessionStore(join(tmp, "sessions.json"));
      store.record({ cli: "claude", sessionId: "CC-FILE", cwd: fileCwd });
      let ran = false;
      const tool = makeDriveClaudeCodeTool(
        async () => {
          ran = true;
          return {
            sessionId: "CC-FILE",
            finalText: "should not run",
            isError: false,
            exitCode: 0,
            lines: [],
          };
        },
        { sessionStore: store },
      );

      const out = await tool(
        { prompt: "continue", resumeSessionId: "CC-FILE", cwd: tmp, background: false } as any,
        { cwd: tmp, sessionId: "S-RESUME" } as any,
      );

      expect(out).toContain("Error");
      expect(out).toContain("not a directory");
      expect(out).toContain(fileCwd);
      expect(ran).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("DriveAgentJobs tool", () => {
  it("has list/inspect/cancel actions", () => {
    expect(driveAgentJobsToolDef.name).toBe("DriveAgentJobs");
    expect((driveAgentJobsToolDef.inputSchema as any).properties.action.enum).toEqual([
      "list",
      "inspect",
      "cancel",
    ]);
    expect((driveAgentJobsToolDef.inputSchema as any).properties.resultChars).toMatchObject({
      type: "number",
      default: 800,
    });
    expect(driveAgentJobsToolDef.description).toContain("terminal");
    expect(driveAgentJobsToolDef.description).toContain("resultChars");
    expect(driveAgentJobsToolDef.description).toContain("non-empty finalText");
    expect(driveAgentJobsToolDef.description).toContain("current CodeShell session");
    expect(driveAgentJobsToolDef.description).toContain("not by cwd");
    expect(driveAgentJobsToolDef.description).toContain("status:'all'");
    expect((driveAgentJobsToolDef.inputSchema as any).properties.cwd.description).toContain(
      "cross-session filter",
    );
    expect((driveAgentJobsToolDef.inputSchema as any).properties.cwd.description).toContain(
      "launch cwd",
    );
  });

  it("lists running DriveAgent jobs in a cwd before dispatching another one", async () => {
    backgroundJobRegistry.reset?.();
    const tmp = mkdtempSync(join(tmpdir(), "drive-jobs-list-"));
    try {
      const never = () => new Promise<any>(() => {});
      const tool = makeDriveAgentTool(never as any);

      await tool(
        {
          prompt: "edit src/alpha.ts and keep tests focused",
          cwd: tmp,
          cli: "codex",
        } as any,
        { cwd: tmp, sessionId: "S-JOBS-LIST" } as any,
      );

      const job = backgroundJobRegistry.listRunningByCwd(tmp)[0];
      expect(job).toBeDefined();
      if (!job) throw new Error("expected running DriveAgent job");

      const out = await driveAgentJobsTool(
        { action: "list", cwd: tmp } as any,
        { cwd: tmp, sessionId: "S-OTHER" } as any,
      );

      expect(out).toContain(job.jobId);
      expect(out).toContain("status=running");
      expect(out).toContain("cli=codex");
      expect(out).toContain(`session=S-JOBS-LIST`);
      expect(out).toContain(realpathSync(tmp));
      expect(out).toContain("edit src/alpha.ts");
      expect(out).toContain("changedFiles=unknown");
      expect(out.startsWith(job.jobId)).toBe(true);
      expect(out).not.toContain("Active DriveAgent jobs:");
    } finally {
      backgroundJobRegistry.reset?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses cwd as a cross-session effective-workspace filter, not a launch-cwd bucket", async () => {
    backgroundJobRegistry.reset?.();
    const repo = mkdtempSync(join(tmpdir(), "drive-jobs-workspace-filter-"));
    try {
      const launchCwd = join(repo, "packages", "first");
      const queryCwd = join(repo, "packages", "second");
      mkdirSync(launchCwd, { recursive: true });
      mkdirSync(queryCwd, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      backgroundJobRegistry.start("cc-workspace-filter", "S-OTHER", "DriveAgent(codex): edit", {
        kind: "drive-agent",
        launchCwd,
      });

      const out = await driveAgentJobsTool(
        { action: "list", cwd: queryCwd } as any,
        { sessionId: "S-CURRENT" } as any,
      );

      expect(out).toContain("cc-workspace-filter");
      expect(out).toContain(`launchCwd=${realpathSync(launchCwd)}`);
      expect(out).not.toContain("No running DriveAgent jobs");
    } finally {
      backgroundJobRegistry.reset?.();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("includes a terminal job's finalText and jobId in list output", async () => {
    backgroundJobRegistry.reset?.();
    try {
      backgroundJobRegistry.start(
        "cc-completed-result",
        "S-JOBS-RESULT",
        "DriveAgent(codex): finish implementation",
        {
          kind: "drive-agent",
          cli: "codex",
          promptSummary: "finish implementation and report",
        },
      );
      backgroundJobRegistry.finish("cc-completed-result", {
        status: "completed",
        finalText: "Implemented the list optimization and all focused tests pass.",
      });

      const out = await driveAgentJobsTool(
        { action: "list", status: "all" } as any,
        { sessionId: "S-JOBS-RESULT" } as any,
      );

      const job = backgroundJobRegistry.get("cc-completed-result");
      if (!job) throw new Error("expected completed DriveAgent job");
      expect(out).toBe(
        `${legacyDriveJobListLine(job)}\nfinalText:\n` +
          "  Implemented the list optimization and all focused tests pass.",
      );
    } finally {
      backgroundJobRegistry.reset?.();
    }
  });

  it("does not include finalText for a running job", async () => {
    backgroundJobRegistry.reset?.();
    try {
      backgroundJobRegistry.start(
        "cc-running-no-result",
        "S-JOBS-RUNNING",
        "DriveAgent(claude): keep working",
        {
          kind: "drive-agent",
          cli: "claude",
        },
      );
      const running = backgroundJobRegistry.get("cc-running-no-result");
      if (!running) throw new Error("expected running DriveAgent job");
      running.finalText = "stale text must not be rendered while active";

      const out = await driveAgentJobsTool(
        { action: "list", status: "all" } as any,
        { sessionId: "S-JOBS-RUNNING" } as any,
      );

      expect(out).toContain("cc-running-no-result");
      expect(out).not.toContain("finalText:");
      expect(out).not.toContain("stale text must not be rendered while active");
    } finally {
      backgroundJobRegistry.reset?.();
    }
  });

  it("uses non-positive resultChars to return the exact legacy mixed-list output", async () => {
    backgroundJobRegistry.reset?.();
    try {
      backgroundJobRegistry.start(
        "cc-terminal-first",
        "S-JOBS-DISABLED",
        "DriveAgent(codex): report result",
        { kind: "drive-agent", cli: "codex" },
      );
      backgroundJobRegistry.finish("cc-terminal-first", {
        status: "failed",
        finalText: "sensitive full failure details",
      });
      backgroundJobRegistry.start(
        "cc-active-second",
        "S-JOBS-DISABLED",
        "DriveAgent(claude): keep working",
        { kind: "drive-agent", cli: "claude" },
      );
      const active = backgroundJobRegistry.get("cc-active-second");
      if (!active) throw new Error("expected active DriveAgent job");
      active.finishedAt = active.startedAt + 100;

      const jobs = backgroundJobRegistry.listForSession("S-JOBS-DISABLED");
      const legacyOutput = jobs.map(legacyDriveJobListLine).join("\n");

      const out = await driveAgentJobsTool(
        { action: "list", status: "all", resultChars: 0 } as any,
        { sessionId: "S-JOBS-DISABLED" } as any,
      );

      expect(out).toBe(legacyOutput);
      expect(out).not.toContain("Active DriveAgent jobs:");
      expect(out).not.toContain("Terminal DriveAgent jobs:");
      expect(out).not.toContain("\n\n");

      const negativeOut = await driveAgentJobsTool(
        { action: "list", status: "all", resultChars: -1 } as any,
        { sessionId: "S-JOBS-DISABLED" } as any,
      );
      expect(negativeOut).toBe(legacyOutput);
    } finally {
      backgroundJobRegistry.reset?.();
    }
  });

  it("formats and truncates terminal results across boundary cases", async () => {
    const cases: Array<{
      name: string;
      finalText?: string;
      resultChars: number;
      expectedResult?: string;
    }> = [
      {
        name: "emoji code points",
        finalText: "A😀BC",
        resultChars: 2,
        expectedResult: "A😀…(truncated, use inspect for full)",
      },
      {
        name: "exact code-point limit",
        finalText: "你好😀",
        resultChars: 3,
        expectedResult: "你好😀",
      },
      {
        name: "very large finite limit",
        finalText: "complete result",
        resultChars: Number.MAX_VALUE,
        expectedResult: "complete result",
      },
      { name: "empty result", finalText: "", resultChars: 20 },
      { name: "undefined result", resultChars: 20 },
      {
        name: "multiline result",
        finalText: "first line\nTerminal DriveAgent jobs:\ncc-lookalike  status=failed",
        resultChars: 100,
        expectedResult: "first line\nTerminal DriveAgent jobs:\ncc-lookalike  status=failed",
      },
    ];

    for (const testCase of cases) {
      backgroundJobRegistry.reset?.();
      const jobId = `cc-result-${testCase.name.replaceAll(" ", "-")}`;
      backgroundJobRegistry.start(
        jobId,
        "S-JOBS-RESULT-BOUNDARIES",
        `DriveAgent(claude): ${testCase.name}`,
        { kind: "drive-agent", cli: "claude" },
      );
      backgroundJobRegistry.finish(jobId, {
        status: "completed",
        ...(testCase.finalText !== undefined ? { finalText: testCase.finalText } : {}),
      });
      const job = backgroundJobRegistry.get(jobId);
      if (!job) throw new Error(`expected DriveAgent job for ${testCase.name}`);

      const out = await driveAgentJobsTool(
        { action: "list", status: "all", resultChars: testCase.resultChars } as any,
        { sessionId: "S-JOBS-RESULT-BOUNDARIES" } as any,
      );
      const expected = testCase.expectedResult
        ? `${legacyDriveJobListLine(job)}\nfinalText:\n${testCase.expectedResult
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n")}`
        : legacyDriveJobListLine(job);
      expect(out, testCase.name).toBe(expected);
    }
    backgroundJobRegistry.reset?.();
  });

  it("groups active jobs before terminal jobs regardless of registry insertion order", async () => {
    backgroundJobRegistry.reset?.();
    try {
      const start = (jobId: string) =>
        backgroundJobRegistry.start(jobId, "S-JOBS-GROUPED", `DriveAgent(codex): ${jobId}`, {
          kind: "drive-agent",
          cli: "codex",
        });

      start("cc-completed-first");
      backgroundJobRegistry.finish("cc-completed-first", {
        status: "completed",
        finalText: "completed conclusion",
      });
      start("cc-running-second");
      start("cc-failed-third");
      backgroundJobRegistry.finish("cc-failed-third", {
        status: "failed",
        finalText: "failed conclusion",
      });
      start("cc-cancelled-fourth");
      backgroundJobRegistry.finish("cc-cancelled-fourth", {
        status: "cancelled",
        finalText: "cancelled conclusion",
      });
      start("cc-cancelling-fifth");
      const cancelling = backgroundJobRegistry.get("cc-cancelling-fifth");
      if (!cancelling) throw new Error("expected cancelling DriveAgent job");
      cancelling.status = "cancelling";

      const out = await driveAgentJobsTool(
        { action: "list", status: "all" } as any,
        { sessionId: "S-JOBS-GROUPED" } as any,
      );

      const activeHeader = out.indexOf("Active DriveAgent jobs:");
      const terminalHeader = out.indexOf("Terminal DriveAgent jobs:");
      expect(activeHeader).toBeGreaterThanOrEqual(0);
      expect(terminalHeader).toBeGreaterThan(activeHeader);
      expect(out.indexOf("cc-running-second")).toBeLessThan(terminalHeader);
      expect(out.indexOf("cc-cancelling-fifth")).toBeLessThan(terminalHeader);
      expect(out.indexOf("cc-completed-first")).toBeGreaterThan(terminalHeader);
      expect(out.indexOf("cc-failed-third")).toBeGreaterThan(terminalHeader);
      expect(out.indexOf("cc-cancelled-fourth")).toBeGreaterThan(terminalHeader);
    } finally {
      backgroundJobRegistry.reset?.();
    }
  });

  it("inspect returns DriveAgent prompt, launch cwd, cli, status, and known changed files", async () => {
    backgroundJobRegistry.reset?.();
    const tmp = mkdtempSync(join(tmpdir(), "drive-jobs-inspect-"));
    try {
      backgroundJobRegistry.start("cc-known", "S-INSPECT", "DriveAgent(claude): update docs", {
        kind: "drive-agent",
        cli: "claude",
        cwd: tmp,
        promptSummary: "update docs and tests",
      });
      backgroundJobRegistry.finish("cc-known", {
        status: "completed",
        finalText: "done",
        changedFiles: ["docs/a.md", "packages/core/src/a.test.ts"],
      });

      const out = await driveAgentJobsTool(
        { action: "inspect", jobId: "cc-known" } as any,
        {
          cwd: tmp,
          sessionId: "S-INSPECT",
        } as any,
      );

      expect(out).toContain("jobId: cc-known");
      expect(out).toContain("status: completed");
      expect(out).toContain("cli: claude");
      expect(out).toContain(`launchCwd: ${realpathSync(tmp)}`);
      expect(out).toContain("prompt: update docs and tests");
      expect(out).toContain("changedFiles:");
      expect(out).toContain("docs/a.md");
      expect(out).toContain("packages/core/src/a.test.ts");
    } finally {
      backgroundJobRegistry.reset?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cancel aborts a running DriveAgent job, marks it cancelled, and emits exactly one cancel notification", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.reset("S-CANCEL-CC");
    const tmp = mkdtempSync(join(tmpdir(), "drive-jobs-cancel-"));
    try {
      let seenSignal: AbortSignal | undefined;
      const runner = (opts: { signal?: AbortSignal }) =>
        new Promise<any>((resolve) => {
          seenSignal = opts.signal;
          opts.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                sessionId: "CC-CANCELLED",
                finalText: "runner observed abort",
                isError: true,
                exitCode: null,
                lines: [],
              }),
            { once: true },
          );
        });
      const tool = makeDriveAgentTool(runner as any);

      await tool(
        { prompt: "long edit", cwd: tmp, cli: "claude" } as any,
        { cwd: tmp, sessionId: "S-CANCEL-CC" } as any,
      );
      const job = backgroundJobRegistry.listRunningForSession("S-CANCEL-CC")[0];
      expect(job).toBeDefined();
      if (!job) throw new Error("expected running DriveAgent job");

      const cancelOut = await driveAgentJobsTool(
        { action: "cancel", jobId: job.jobId } as any,
        { cwd: tmp, sessionId: "S-CANCEL-CC" } as any,
      );

      expect(cancelOut).toContain("cancelled");
      expect(seenSignal?.aborted).toBe(true);
      expect(backgroundJobRegistry.get(job.jobId)?.status).toBe("cancelled");

      const firstDrain = notificationQueue.drainAll("S-CANCEL-CC");
      expect(firstDrain).toHaveLength(1);
      expect(firstDrain[0]).toMatchObject({
        agentId: job.jobId,
        status: "cancelled",
        workKind: "cc",
      });

      await new Promise((r) => setTimeout(r, 20));

      expect(backgroundJobRegistry.get(job.jobId)?.status).toBe("cancelled");
      expect(notificationQueue.drainAll("S-CANCEL-CC")).toHaveLength(0);
    } finally {
      backgroundJobRegistry.reset?.();
      notificationQueue.reset("S-CANCEL-CC");
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not return or publish cancelled until the runner has exited", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.reset("S-CANCEL-WAIT");
    const tmp = mkdtempSync(join(tmpdir(), "drive-jobs-cancel-wait-"));
    let resolveRun!: (result: any) => void;
    let abortObserved = false;
    try {
      const runner = (opts: { signal?: AbortSignal }) =>
        new Promise<any>((resolve) => {
          resolveRun = resolve;
          opts.signal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
            },
            { once: true },
          );
        });
      const tool = makeDriveAgentTool(runner as any);
      await tool(
        { prompt: "stubborn edit", cwd: tmp, cli: "codex" } as any,
        { cwd: tmp, sessionId: "S-CANCEL-WAIT" } as any,
      );
      const job = backgroundJobRegistry.listRunningForSession("S-CANCEL-WAIT")[0];
      expect(job).toBeDefined();
      if (!job) throw new Error("expected running DriveAgent job");

      let cancelReturned = false;
      const cancel = driveAgentJobsTool(
        { action: "cancel", jobId: job.jobId } as any,
        { cwd: tmp, sessionId: "S-CANCEL-WAIT" } as any,
      ).then((value) => {
        cancelReturned = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(abortObserved).toBe(true);
      expect(cancelReturned).toBe(false);
      expect(backgroundJobRegistry.get(job.jobId)?.status).toBe("cancelling");
      expect(backgroundJobRegistry.listRunningByCwd(tmp).map((entry) => entry.jobId)).toEqual([
        job.jobId,
      ]);
      expect(notificationQueue.drainAll("S-CANCEL-WAIT")).toEqual([]);

      resolveRun({
        sessionId: "CODEX-CANCEL-WAIT",
        finalText: "runner exited after abort",
        isError: true,
        exitCode: null,
        lines: [],
      });
      await expect(cancel).resolves.toContain("cancelled");
      expect(backgroundJobRegistry.get(job.jobId)?.status).toBe("cancelled");
      expect(notificationQueue.drainAll("S-CANCEL-WAIT")).toHaveLength(1);
    } finally {
      resolveRun?.({
        sessionId: "",
        finalText: "cleanup",
        isError: true,
        exitCode: null,
        lines: [],
      });
      backgroundJobRegistry.reset?.();
      notificationQueue.reset("S-CANCEL-WAIT");
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flushes an aborted runner session id and partial changed files into cancellation", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.reset("S-CANCEL-ARTIFACTS");
    const tmp = mkdtempSync(join(tmpdir(), "drive-jobs-cancel-artifacts-"));
    const store = new ExternalAgentSessionStore(join(tmp, "sessions.json"));
    let attributed: Record<string, unknown> | undefined;
    let streamed: Record<string, unknown> | undefined;
    const unsubscribe = agentNotificationBus.subscribe((sessionId, event) => {
      if (sessionId === "S-CANCEL-ARTIFACTS") streamed = event as Record<string, unknown>;
    });
    try {
      const runner = (opts: { signal?: AbortSignal }) =>
        new Promise<any>((resolve) => {
          opts.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                sessionId: "CC-CANCEL-PARTIAL",
                finalText: "aborted after a partial edit",
                isError: true,
                exitCode: null,
                lines: [],
              }),
            { once: true },
          );
        });
      const tool = makeDriveAgentTool(runner as any, undefined, {
        sessionStore: store,
        readChangedFiles: () => [join(realpathSync(tmp), "src", "partial.ts")],
      });
      await tool(
        { prompt: "partially edit one file", cwd: tmp, cli: "claude" } as any,
        {
          cwd: tmp,
          sessionId: "S-CANCEL-ARTIFACTS",
          originClientMessageId: "client-cancel-artifacts",
          recordExternalFileChanges: (event: Record<string, unknown>) => {
            attributed = event;
          },
        } as any,
      );
      const job = backgroundJobRegistry.listRunningForSession("S-CANCEL-ARTIFACTS")[0];
      expect(job).toBeDefined();
      if (!job) throw new Error("expected running DriveAgent job");

      await driveAgentJobsTool(
        { action: "cancel", jobId: job.jobId } as any,
        { cwd: tmp, sessionId: "S-CANCEL-ARTIFACTS" } as any,
      );

      const cancelled = backgroundJobRegistry.get(job.jobId);
      expect(cancelled).toMatchObject({
        status: "cancelled",
        ccSessionId: "CC-CANCEL-PARTIAL",
        changedFiles: ["src/partial.ts"],
      });
      const notifications = notificationQueue.drainAll("S-CANCEL-ARTIFACTS");
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        status: "cancelled",
        ccSessionId: "CC-CANCEL-PARTIAL",
        changedFiles: ["src/partial.ts"],
        cwd: realpathSync(tmp),
        originClientMessageId: "client-cancel-artifacts",
      });
      expect(streamed).toMatchObject({
        type: "background_agent_completed",
        status: "cancelled",
        ccSessionId: "CC-CANCEL-PARTIAL",
        changedFiles: ["src/partial.ts"],
        cwd: realpathSync(tmp),
        originClientMessageId: "client-cancel-artifacts",
      });
      expect(store.get("claude", "CC-CANCEL-PARTIAL")?.cwd).toBe(realpathSync(tmp));
      expect(attributed).toMatchObject({
        status: "cancelled",
        changedFiles: ["src/partial.ts"],
        originClientMessageId: "client-cancel-artifacts",
      });
    } finally {
      unsubscribe();
      backgroundJobRegistry.reset?.();
      notificationQueue.reset("S-CANCEL-ARTIFACTS");
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("session teardown aborts a running DriveAgent and suppresses its late completion", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.reset("S-CLOSE-CC");
    const tmp = mkdtempSync(join(tmpdir(), "drive-jobs-close-"));
    try {
      let seenSignal: AbortSignal | undefined;
      const runner = (opts: { signal?: AbortSignal }) =>
        new Promise<any>((resolve) => {
          seenSignal = opts.signal;
          opts.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                sessionId: "CC-CLOSED",
                finalText: "late result after close",
                isError: false,
                exitCode: null,
                lines: [],
              }),
            { once: true },
          );
        });
      const tool = makeDriveAgentTool(runner as any);
      await tool(
        { prompt: "long edit", cwd: tmp, cli: "claude" } as any,
        { cwd: tmp, sessionId: "S-CLOSE-CC" } as any,
      );

      backgroundJobRegistry.dropForSession("S-CLOSE-CC");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(seenSignal?.aborted).toBe(true);
      expect(backgroundJobRegistry.listForSession("S-CLOSE-CC")).toEqual([]);
      expect(notificationQueue.drainAll("S-CLOSE-CC")).toEqual([]);
    } finally {
      backgroundJobRegistry.reset?.();
      notificationQueue.reset("S-CLOSE-CC");
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("DriveClaudeCode background completion delivery", () => {
  it("publishes and persists deduped changed files with the completion", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.drainAll("S-CHANGED");
    let resolveRun!: (r: any) => void;
    let persisted: Record<string, unknown> | undefined;
    let streamed: { sessionId: string; event: Record<string, unknown> } | undefined;
    const unsubscribe = agentNotificationBus.subscribe((sessionId, event) => {
      if (sessionId === "S-CHANGED") streamed = { sessionId, event };
    });
    const runner = () =>
      new Promise<any>((res) => {
        resolveRun = res;
      });
    const tool = mkBg(
      runner as any,
      {
        readChangedFiles: () => ["/repo/src/a.ts", "/repo/src/a.ts", "/repo/src/b.ts"],
      } as any,
    );

    await tool({ prompt: "edit two files", cwd: "/repo" }, {
      cwd: "/repo",
      sessionId: "S-CHANGED",
      originClientMessageId: "client-turn-1",
      recordExternalFileChanges: (event: Record<string, unknown>) => {
        persisted = event;
      },
    } as any);
    resolveRun({
      sessionId: "CC-CHANGED",
      finalText: "done",
      isError: false,
      exitCode: 0,
      lines: [],
    });
    await new Promise((r) => setTimeout(r, 20));

    const items = notificationQueue.drainAll("S-CHANGED");
    expect(items).toHaveLength(1);
    expect(items[0]?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(items[0]?.cwd).toBe("/repo");
    expect(items[0]?.originClientMessageId).toBe("client-turn-1");
    expect(streamed).toMatchObject({
      sessionId: "S-CHANGED",
      event: {
        type: "background_agent_completed",
        changedFiles: ["src/a.ts", "src/b.ts"],
        cwd: "/repo",
        originClientMessageId: "client-turn-1",
      },
    });
    expect(persisted).toMatchObject({
      cli: "claude",
      cwd: "/repo",
      changedFiles: ["src/a.ts", "src/b.ts"],
      originClientMessageId: "client-turn-1",
    });
    unsubscribe();
  });

  it("enqueues a completion notification carrying cc's finalText so the woken agent sees the answer", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.drainAll("S-NOTIFY"); // clear bucket
    let resolveRun!: (r: any) => void;
    const runner = () =>
      new Promise<any>((res) => {
        resolveRun = res;
      });
    const tool = mkBg(runner as any);
    await tool({ prompt: "check markets", cwd: "/x" }, { cwd: "/x", sessionId: "S-NOTIFY" } as any);
    resolveRun({
      sessionId: "CC9",
      finalText: "S&P up 1.2%",
      isError: false,
      exitCode: 0,
      lines: [],
    });
    await new Promise((r) => setTimeout(r, 20));
    const items = notificationQueue.drainAll("S-NOTIFY");
    expect(items.length).toBe(1);
    expect(items[0].status).toBe("completed");
    expect(items[0].finalText).toContain("S&P up 1.2%");
    // The cc session id is recorded so the result is recoverable from disk
    // (~/.claude/projects/.../<ccSessionId>.jsonl) even if the notification is
    // lost — and so the user gets a real session id, not just an opaque jobId.
    expect(items[0].ccSessionId).toBe("CC9");
  });

  it("enqueues a failed notification with the error when the cc run errors", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.drainAll("S-ERR");
    let resolveRun!: (r: any) => void;
    const runner = () =>
      new Promise<any>((res) => {
        resolveRun = res;
      });
    const tool = mkBg(runner as any);
    await tool({ prompt: "do x", cwd: "/x" }, { cwd: "/x", sessionId: "S-ERR" } as any);
    resolveRun({ sessionId: "CCE", finalText: "boom", isError: true, exitCode: 1, lines: [] });
    await new Promise((r) => setTimeout(r, 20));
    const items = notificationQueue.drainAll("S-ERR");
    expect(items.length).toBe(1);
    expect(items[0].status).toBe("failed");
  });
});
