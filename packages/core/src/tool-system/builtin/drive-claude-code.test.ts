import { describe, it, expect } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  driveClaudeCodeToolDef,
  makeDriveClaudeCodeTool,
  driveAgentToolDef,
  makeDriveAgentTool,
} from "./drive-claude-code.js";
import { backgroundJobRegistry } from "./background-jobs.js";
import { notificationQueue } from "./agent-notifications.js";
import { makeDriveClaudeCodeTool as mkBg } from "./drive-claude-code.js";
import { ExternalAgentSessionStore } from "../../cc-orchestrator/external-agent-session-store.js";
import { BUILTIN_TOOLS } from "./index.js";

describe("DriveAgent tool", () => {
  it("has a name and an inputSchema with prompt + background + cli", () => {
    expect(driveAgentToolDef.name).toBe("DriveAgent");
    expect((driveAgentToolDef.inputSchema as any).properties.prompt).toBeDefined();
    expect((driveAgentToolDef.inputSchema as any).properties.background).toBeDefined();
    expect((driveAgentToolDef.inputSchema as any).properties.cli.enum).toEqual(["claude", "codex"]);
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
    expect(drive?.timeoutMs).toBeGreaterThan(120_000);
    expect(alias?.timeoutMs).toBe(drive?.timeoutMs);
  });

  it("passes the ToolContext AbortSignal through to the runner", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const tool = makeDriveAgentTool(async (o) => {
      seen = o.signal;
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool(
      { prompt: "p", cwd: "/x", background: false } as any,
      { cwd: "/x", sessionId: "S-CTX", signal: controller.signal } as any,
    );
    expect(seen).toBe(controller.signal);
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

  it("uses the registry-injected __signal when ToolContext is absent", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const tool = makeDriveAgentTool(async (o) => {
      seen = o.signal;
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "p", cwd: "/x", background: false, __signal: controller.signal } as any);
    expect(seen).toBe(controller.signal);
  });
});

describe("DriveClaudeCode alias (back-compat)", () => {
  it("has a name and an inputSchema with prompt + background", () => {
    expect(driveClaudeCodeToolDef.name).toBe("DriveClaudeCode");
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.prompt).toBeDefined();
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.background).toBeDefined();
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
      expect(backgroundJobRegistry.listRunningForSession("S-CWD").map((j) => j.cwd)).toEqual([
        realpathSync(tmp),
        realpathSync(tmp),
      ]);
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

describe("DriveClaudeCode background completion delivery", () => {
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
