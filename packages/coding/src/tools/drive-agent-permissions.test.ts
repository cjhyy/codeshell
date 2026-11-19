import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundJobRegistry, notificationQueue } from "@cjhyy/code-shell-core/extension";
import { makeDriveAgentTool } from "./drive-agent.js";
import {
  DRIVE_MAX_CONSECUTIVE_DENIALS,
  createDrivePermissionGate,
  describeDenials,
  drivePermissionLaunchNote,
  prepareDriveRunPermissions,
  resolveDrivePermissionMode,
  startDrivePermissionPrompt,
} from "./drive-agent-permissions.js";

const bash = { toolName: "Bash", input: { command: "git status" } };

describe("resolveDrivePermissionMode", () => {
  it("honors an explicit valid mode over the parent's", () => {
    expect(
      resolveDrivePermissionMode({
        requested: "acceptEdits",
        parentMode: "bypassPermissions",
        externalRuntime: false,
      }),
    ).toEqual({ mode: "acceptEdits", source: "explicit" });
  });

  it("inherits full access and accept-edits, and nothing wider", () => {
    const inherit = (parentMode: string) =>
      resolveDrivePermissionMode({ requested: undefined, parentMode, externalRuntime: true });
    expect(inherit("bypassPermissions")).toEqual({
      mode: "bypassPermissions",
      source: "inherited",
    });
    expect(inherit("acceptEdits")).toEqual({ mode: "acceptEdits", source: "inherited" });
    for (const mode of ["default", "plan", "auto", "dontAsk"])
      expect(inherit(mode)).toEqual({ mode: "default", source: "inherited" });
  });

  it("keeps the historical defaults only when no session mode exists", () => {
    const orphan = (externalRuntime: boolean) =>
      resolveDrivePermissionMode({ requested: "nonsense", parentMode: undefined, externalRuntime });
    expect(orphan(false)).toEqual({ mode: "bypassPermissions", source: "no-session" });
    expect(orphan(true)).toEqual({ mode: "default", source: "no-session" });
  });
});

describe("createDrivePermissionGate", () => {
  it("routes an ask to the session, labelled with the task title", async () => {
    const asked: unknown[] = [];
    const gate = createDrivePermissionGate({
      title: "Fix login test",
      mode: "acceptEdits",
      requestApproval: async (request) => {
        asked.push(request);
        return { approved: true };
      },
      onBlocked: () => {
        throw new Error("must not block");
      },
    });
    expect(await gate.decide(bash)).toEqual({ approved: true });
    expect(asked).toEqual([
      {
        toolName: "Claude Code Bash",
        args: { command: "git status" },
        reason: "Requested by background task «Fix login test» (DriveAgent worker).",
        // Aborted when the ask stops being awaited, so its prompt is withdrawn.
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(gate.snapshot()).toEqual({});
  });

  it("denies and says why when there is no approval path, then blocks after the limit", async () => {
    const blocked: string[] = [];
    const gate = createDrivePermissionGate({
      title: "t",
      mode: "acceptEdits",
      onBlocked: (reason) => blocked.push(reason),
    });
    for (let index = 1; index <= DRIVE_MAX_CONSECUTIVE_DENIALS; index += 1) {
      const decision = await gate.decide(bash);
      expect(decision.approved).toBe(false);
      expect(decision.reason).toContain("no approval path");
      expect(blocked).toHaveLength(index === DRIVE_MAX_CONSECUTIVE_DENIALS ? 1 : 0);
    }
    expect(blocked[0]).toBe(
      '3 consecutive operations were denied (Bash ×3) under permissionMode "acceptEdits"',
    );
    expect(gate.snapshot()).toEqual({ permissionDenials: 3, blocked: "permission" });
    // Once stopped nothing is asked again, and the callback does not repeat.
    await gate.decide(bash);
    expect(blocked).toHaveLength(1);
  });

  it("only counts CONSECUTIVE denials: an approval resets the streak", async () => {
    const answers = [false, false, true, false, false];
    const blocked: string[] = [];
    const gate = createDrivePermissionGate({
      title: "t",
      mode: "default",
      requestApproval: async () => ({ approved: answers.shift()!, reason: "no" }),
      onBlocked: (reason) => blocked.push(reason),
    });
    for (let index = 0; index < 5; index += 1) await gate.decide(bash);
    expect(blocked).toEqual([]);
    expect(gate.snapshot()).toEqual({ permissionDenials: 4 });
  });

  it("reports the wait while an approval is pending and stops when it goes unanswered", async () => {
    const blocked: string[] = [];
    let changes = 0;
    const gate = createDrivePermissionGate({
      title: "t",
      mode: "default",
      requestApproval: () => new Promise(() => {}),
      onBlocked: (reason) => blocked.push(reason),
      approvalWaitLimitMs: 20,
      now: () => 1_234,
    });
    gate.setListener(() => {
      changes += 1;
    });
    const pending = gate.decide({ toolName: "WebFetch", input: {} });
    expect(gate.snapshot()).toEqual({ awaitingApprovalSince: 1_234 });
    expect(await pending).toEqual({
      approved: false,
      reason: "The approval request was not answered in time.",
    });
    expect(blocked).toEqual(["an approval for WebFetch went unanswered for 1 min"]);
    expect(gate.snapshot()).toEqual({ permissionDenials: 1, blocked: "permission" });
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it("fails closed when the approval path throws", async () => {
    const gate = createDrivePermissionGate({
      title: "t",
      mode: "default",
      requestApproval: async () => {
        throw new Error("boom");
      },
      onBlocked: () => {},
    });
    expect((await gate.decide(bash)).approved).toBe(false);
  });
});

describe("prepareDriveRunPermissions", () => {
  const noPrompt = async () => {
    throw new Error("no bridge in this test");
  };

  it("does not gate Codex or a full-access worker", async () => {
    for (const input of [
      { cli: "codex" as const, mode: "default" as const },
      { cli: "claude" as const, mode: "bypassPermissions" as const },
    ]) {
      const permissions = await prepareDriveRunPermissions({
        ...input,
        title: "t",
        stop: () => {},
        startPrompt: async () => {
          throw new Error("must not start a prompt bridge");
        },
      });
      expect(permissions.permissionPrompt).toBeUndefined();
      expect(permissions.outcome({ permissionDenials: [] })).toEqual({ denials: 0 });
    }
  });

  it("turns the CLI's own denial report into a degraded outcome", async () => {
    const permissions = await prepareDriveRunPermissions({
      cli: "claude",
      mode: "acceptEdits",
      title: "t",
      stop: () => {},
      startPrompt: noPrompt,
    });
    expect(permissions.routed).toBe(false);
    const outcome = permissions.outcome({
      sessionId: "abc",
      permissionDenials: [{ toolName: "Bash" }, { toolName: "Bash" }, { toolName: "WebFetch" }],
    });
    expect(outcome.denials).toBe(3);
    expect(outcome.blocked).toBeUndefined();
    expect(outcome.note).toStartWith(
      '[permissions] Completed with 3 denied operation(s) (Bash ×2, WebFetch ×1) under permissionMode "acceptEdits".',
    );
    expect(outcome.note).toContain("NOT complete");
    expect(outcome.note).toContain("session abc");
  });

  it("stops the run and reports blocked once the gate gives up", async () => {
    let stopped = 0;
    let decide!: (request: typeof bash) => Promise<unknown>;
    const permissions = await prepareDriveRunPermissions({
      cli: "claude",
      mode: "default",
      title: "t",
      stop: () => {
        stopped += 1;
      },
      startPrompt: async (gate) => {
        decide = (request) => gate.decide(request);
        return {
          permissionPrompt: { mcpConfigPath: "/x", toolName: "mcp__s__t" },
          close: async () => {},
        };
      },
    });
    expect(permissions.permissionPrompt).toEqual({ mcpConfigPath: "/x", toolName: "mcp__s__t" });
    for (let index = 0; index < 3; index += 1) await decide(bash);
    expect(stopped).toBe(1);
    const outcome = permissions.outcome();
    expect(outcome.blocked).toContain("3 consecutive operations were denied");
    expect(outcome.note).toStartWith("[permissions] Stopped early:");
    expect(
      permissions.progress({ lastActivityAt: 1, eventCount: 1, permissionDenials: 1 }),
    ).toEqual({ lastActivityAt: 1, eventCount: 1, permissionDenials: 3, blocked: "permission" });
  });
});

describe("startDrivePermissionPrompt", () => {
  it("serves exactly the permission prompt over a private, token-guarded bridge", async () => {
    const seen: unknown[] = [];
    const prompt = await startDrivePermissionPrompt({
      decide: async (request) => {
        seen.push(request);
        return { approved: request.toolName !== "Bash", reason: "not now" };
      },
    });
    const { mcpConfigPath, toolName } = prompt.permissionPrompt;
    try {
      expect(toolName).toBe("mcp__codeshell_approval__CodeShellPermissionPrompt");
      const server = JSON.parse(readFileSync(mcpConfigPath, "utf8")).mcpServers.codeshell_approval;
      const call = async (body: unknown, authorization = server.headers.Authorization) => {
        const response = await fetch(server.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization,
          },
          body: JSON.stringify(body),
        });
        return {
          status: response.status,
          json: (await response.json().catch(() => undefined)) as any,
        };
      };
      expect(
        (await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "Bearer wrong")).status,
      ).toBe(401);
      const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(listed.json.result.tools.map((tool: any) => tool.name)).toEqual([
        "CodeShellPermissionPrompt",
      ]);
      const ask = (id: number, tool_name: string) =>
        call({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "CodeShellPermissionPrompt",
            arguments: { tool_name, input: { command: "ls" }, tool_use_id: "u1" },
          },
        });
      expect(JSON.parse((await ask(3, "Bash")).json.result.content[0].text)).toEqual({
        behavior: "deny",
        message: "not now",
      });
      expect(JSON.parse((await ask(4, "Read")).json.result.content[0].text)).toEqual({
        behavior: "allow",
        updatedInput: { command: "ls" },
      });
      expect(seen).toEqual([
        { toolName: "Bash", input: { command: "ls" }, toolUseId: "u1" },
        { toolName: "Read", input: { command: "ls" }, toolUseId: "u1" },
      ]);
    } finally {
      await prompt.close();
    }
    expect(existsSync(mcpConfigPath)).toBe(false);
  });
});

describe("launch note and denial text", () => {
  it("names the tools only", () => {
    expect(
      describeDenials([{ toolName: "Bash" }, { toolName: "Edit" }, { toolName: "Bash" }]),
    ).toBe("Bash ×2, Edit ×1");
  });

  it("states plainly when Bash will be denied", () => {
    const note = drivePermissionLaunchNote({
      cli: "claude",
      mode: "acceptEdits",
      source: "inherited",
      routed: false,
    });
    expect(note).toContain("Permission mode: acceptEdits (inherited from this session).");
    expect(note).toContain("Bash (git, tests, installs)");
    expect(note).toContain("every such operation is DENIED");
    expect(
      drivePermissionLaunchNote({
        cli: "claude",
        mode: "default",
        source: "explicit",
        routed: true,
      }),
    ).toContain("sent to this session's approval prompt");
    expect(
      drivePermissionLaunchNote({
        cli: "codex",
        mode: "default",
        source: "inherited",
        routed: false,
      }),
    ).toContain("READ-ONLY sandbox");
  });
});

describe("DriveAgent permission wiring", () => {
  const sessionStore = { get: () => undefined, record: () => undefined };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  async function withTool<T>(sessionId: string, body: (dir: string) => Promise<T>): Promise<T> {
    backgroundJobRegistry.reset();
    notificationQueue.reset(sessionId);
    const dir = mkdtempSync(join(tmpdir(), "drive-perm-"));
    try {
      return await body(dir);
    } finally {
      await settle();
      backgroundJobRegistry.reset();
      notificationQueue.reset(sessionId);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("inherits the session's mode, hands the worker a prompt tool and titles the job", async () => {
    await withTool("S-PERM-INHERIT", async (dir) => {
      let seen: any;
      const tool = makeDriveAgentTool(
        async (options) => {
          seen = options;
          return { sessionId: "ext-1", finalText: "ok", isError: false, exitCode: 0, lines: [] };
        },
        undefined,
        { sessionStore },
      );
      const output = await tool({ prompt: "do the thing", title: "  Fix login test ", cwd: dir }, {
        cwd: dir,
        sessionId: "S-PERM-INHERIT",
        permissionMode: "acceptEdits",
        requestDelegatedToolApproval: async () => ({ approved: true }),
      } as any);
      await settle();
      expect(seen.permissionMode).toBe("acceptEdits");
      expect(seen.permissionPrompt.toolName).toBe(
        "mcp__codeshell_approval__CodeShellPermissionPrompt",
      );
      expect(output).toContain("Permission mode: acceptEdits (inherited from this session).");
      expect(output).toContain("sent to this session's approval prompt");
      // The bridge is torn down with the run.
      expect(existsSync(seen.permissionPrompt.mcpConfigPath)).toBe(false);
      const [result] = notificationQueue.drainAll("S-PERM-INHERIT") as any[];
      expect(result.payload).toMatchObject({
        name: "Fix login test",
        description: "Fix login test",
        status: "completed",
      });
      expect(result.payload.permissionDenials).toBeUndefined();
      expect(backgroundJobRegistry.listForSession("S-PERM-INHERIT")[0]?.description).toBe(
        "Fix login test",
      );
    });
  });

  it("maps a full-access session to an unattended worker with no prompt tool", async () => {
    await withTool("S-PERM-FULL", async (dir) => {
      const seen: any[] = [];
      const tool = makeDriveAgentTool(
        async (options) => {
          seen.push(options);
          return { sessionId: "ext-2", finalText: "ok", isError: false, exitCode: 0, lines: [] };
        },
        undefined,
        { sessionStore },
      );
      for (const ctx of [
        { permissionMode: "bypassPermissions" },
        // External-runtime hosts express full access as path authority.
        { permissionMode: "acceptEdits", pathAccess: "full", externalRuntime: true },
      ]) {
        const output = await tool({ prompt: "p", cwd: dir, background: false }, {
          cwd: dir,
          sessionId: "S-PERM-FULL",
          ...ctx,
        } as any);
        expect(output).toContain("完成（session ext-2）");
      }
      expect(seen.map((options) => options.permissionMode)).toEqual([
        "bypassPermissions",
        "bypassPermissions",
      ]);
      expect(seen.every((options) => options.permissionPrompt === undefined)).toBe(true);
    });
  });

  it("does not report a run with denied operations as plainly completed", async () => {
    await withTool("S-PERM-DENIED", async (dir) => {
      const tool = makeDriveAgentTool(
        async () => ({
          sessionId: "ext-3",
          finalText: "I could not run the tests.",
          isError: false,
          permissionDenials: [{ toolName: "Bash" }, { toolName: "Bash" }],
          exitCode: 0,
          lines: [],
        }),
        undefined,
        { sessionStore },
      );
      const ctx = { cwd: dir, sessionId: "S-PERM-DENIED", permissionMode: "acceptEdits" } as any;
      const launched = await tool({ prompt: "run tests and commit", cwd: dir }, ctx);
      expect(launched).toContain("every such operation is DENIED");
      await settle();
      const [result] = notificationQueue.drainAll("S-PERM-DENIED") as any[];
      expect(result.payload.status).toBe("completed");
      expect(result.payload.permissionDenials).toBe(2);
      expect(result.payload.finalText).toStartWith(
        "[permissions] Completed with 2 denied operation(s) (Bash ×2)",
      );
      expect(result.payload.finalText).toEndWith("I could not run the tests.");
      const job = backgroundJobRegistry.listForSession("S-PERM-DENIED")[0]!;
      expect(job.status).toBe("completed");
      expect(job.progress?.permissionDenials).toBe(2);

      const inline = await tool({ prompt: "run tests", cwd: dir, background: false }, ctx);
      expect(inline).toContain("完成，但有 2 个操作被拒（session ext-3）");
    });
  });

  it("stops a worker that can only be denied and wakes the parent with a failure", async () => {
    await withTool("S-PERM-BLOCKED", async (dir) => {
      let aborted = false;
      const tool = makeDriveAgentTool(
        (options) =>
          new Promise((resolve) => {
            options.signal?.addEventListener("abort", () => {
              aborted = true;
              // An aborted CLI exits without a terminal result record.
              resolve({
                sessionId: "ext-4",
                finalText: "",
                isError: false,
                exitCode: null,
                lines: [],
              });
            });
          }),
        undefined,
        {
          sessionStore,
          startPermissionPrompt: async (gate) => {
            // The worker asks three times; nobody can answer in this session.
            setTimeout(async () => {
              for (let index = 0; index < 3; index += 1) await gate.decide(bash);
            }, 5);
            return {
              permissionPrompt: { mcpConfigPath: "/x", toolName: "mcp__s__t" },
              close: async () => {},
            };
          },
        },
      );
      await tool({ prompt: "commit it", title: "Commit fix", cwd: dir }, {
        cwd: dir,
        sessionId: "S-PERM-BLOCKED",
        permissionMode: "default",
      } as any);
      await settle();
      await settle();
      expect(aborted).toBe(true);
      const [result] = notificationQueue.drainAll("S-PERM-BLOCKED") as any[];
      expect(result.payload).toMatchObject({
        name: "Commit fix",
        status: "failed",
        permissionDenials: 3,
      });
      expect(result.payload.error).toStartWith(
        "[permissions] Stopped early: 3 consecutive operations were denied (Bash ×3)",
      );
      const job = backgroundJobRegistry.listForSession("S-PERM-BLOCKED")[0]!;
      expect(job.status).toBe("failed");
      expect(job.progress).toMatchObject({ permissionDenials: 3, blocked: "permission" });
    });
  });
});

describe("a cancelled ask", () => {
  it("is refused without being counted as a permission denial", async () => {
    const gate = createDrivePermissionGate({
      title: "t",
      mode: "default",
      requestApproval: () => new Promise(() => {}),
      onBlocked: () => {
        throw new Error("must not block");
      },
    });
    const controller = new AbortController();
    const pending = gate.decide(bash, controller.signal);
    expect(gate.snapshot().awaitingApprovalSince).toBeNumber();
    controller.abort();
    expect(await pending).toEqual({
      approved: false,
      reason: "The permission request was cancelled.",
    });
    expect(gate.snapshot()).toEqual({});
  });
});

describe("an approval prompt never outlives its worker", () => {
  /** A host that keeps each prompt up until it is answered or withdrawn. */
  function host() {
    const prompts: Array<{ toolName: string; signal: AbortSignal; withdrawn: boolean }> = [];
    const requestApproval = (request: { toolName: string; signal?: AbortSignal }) =>
      new Promise<{ approved: boolean; reason?: string }>((resolve) => {
        const prompt = { toolName: request.toolName, signal: request.signal!, withdrawn: false };
        prompts.push(prompt);
        request.signal!.addEventListener("abort", () => {
          prompt.withdrawn = true;
          resolve({ approved: false, reason: "withdrawn" });
        });
      });
    return { prompts, requestApproval };
  }

  it("a worker that is cancelled while it waits withdraws its prompt", async () => {
    const { prompts, requestApproval } = host();
    const gate = createDrivePermissionGate({
      title: "t",
      mode: "default",
      requestApproval,
      onBlocked: () => {
        throw new Error("must not block");
      },
    });
    const worker = new AbortController();
    const pending = gate.decide(bash, worker.signal);
    expect(prompts.map((prompt) => prompt.withdrawn)).toEqual([false]);
    worker.abort();
    expect(await pending).toEqual({
      approved: false,
      reason: "The permission request was cancelled.",
    });
    expect(prompts[0]!.withdrawn).toBe(true);
    expect(gate.denials()).toEqual([]);
  });

  it("an ask that times out withdraws its prompt as it stops the worker", async () => {
    const { prompts, requestApproval } = host();
    const blocked: string[] = [];
    const gate = createDrivePermissionGate({
      title: "t",
      mode: "default",
      requestApproval,
      onBlocked: (reason) => blocked.push(reason),
      approvalWaitLimitMs: 5,
    });
    expect(await gate.decide(bash)).toEqual({
      approved: false,
      reason: "The approval request was not answered in time.",
    });
    expect(blocked).toHaveLength(1);
    expect(prompts[0]!.withdrawn).toBe(true);
  });

  it("stopping the worker for repeated denials withdraws its other open prompts, uncounted", async () => {
    const prompts: Array<{ toolName: string; withdrawn: boolean }> = [];
    const gate = createDrivePermissionGate({
      title: "t",
      mode: "default",
      maxConsecutiveDenials: 1,
      requestApproval: (request) =>
        new Promise((resolve) => {
          const prompt = { toolName: request.toolName, withdrawn: false };
          prompts.push(prompt);
          // The edit is denied by the user at once; the shell ask stays open.
          if (request.toolName === "Claude Code Edit") resolve({ approved: false });
          request.signal!.addEventListener("abort", () => {
            prompt.withdrawn = true;
            resolve({ approved: false, reason: "withdrawn" });
          });
        }),
      onBlocked: () => {},
    });
    const open = gate.decide(bash);
    expect(await gate.decide({ toolName: "Edit", input: {} })).toMatchObject({ approved: false });
    expect(gate.blockedReason()).toBeDefined();
    expect(await open).toEqual({
      approved: false,
      reason: "The permission request was cancelled.",
    });
    expect(prompts.find((prompt) => prompt.toolName === "Claude Code Bash")!.withdrawn).toBe(true);
    // Only the user's own refusal is a denial.
    expect(gate.denials()).toEqual([{ toolName: "Edit" }]);
  });

  it("closing a run withdraws whatever it still has on screen", async () => {
    const { prompts, requestApproval } = host();
    let decide!: Parameters<
      NonNullable<Parameters<typeof prepareDriveRunPermissions>[0]["startPrompt"]>
    >[0]["decide"];
    const permissions = await prepareDriveRunPermissions({
      cli: "claude",
      mode: "default",
      title: "t",
      requestApproval,
      stop: () => {},
      startPrompt: async (gate) => {
        decide = gate.decide;
        return {
          permissionPrompt: { mcpConfigPath: "/dev/null", toolName: "prompt" },
          close: async () => {},
        };
      },
    });
    const pending = decide(bash);
    expect(prompts[0]!.withdrawn).toBe(false);
    // The process ended (finished, was cancelled, or timed out) with the ask open.
    await permissions.close();
    expect(prompts[0]!.withdrawn).toBe(true);
    expect(await pending).toMatchObject({ approved: false });
    expect(permissions.outcome().denials).toBe(0);
  });
});
