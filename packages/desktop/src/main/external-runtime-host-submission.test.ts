import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { SessionManager, type GoalConfig } from "@cjhyy/code-shell-core";
import type { InputAttachmentMeta } from "@cjhyy/code-shell-server/storage";
import { createExternalRuntimeHostSubmission } from "./external-runtime-host-submission.js";
import type {
  DesktopExternalRuntimeTurnInput,
  ExternalRuntimeService,
  ExternalRuntimeStartRequest,
  ExternalRuntimeSubmissionHooks,
} from "./external-runtime-service.js";
import type { ExternalRuntimeTurnOutcome } from "./external-runtime-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let storage: string;
const finishers: Array<() => void> = [];

beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), "codeshell-host-external-submission-"));
});

afterEach(async () => {
  for (const finish of finishers.splice(0)) finish();
  // Drain the helper's handled background completions before removing fixtures.
  await Promise.resolve();
  await Promise.resolve();
  rmSync(storage, { recursive: true, force: true });
});

function harness(
  options: {
    busy?: boolean;
    ensureFailure?: Error;
    duringEnsure?: () => void;
    hasOwner?: boolean;
    resolvedWorkspace?: { cwd: string; mainRoot: string };
    workspaceFailure?: Error;
  } = {},
) {
  const sessions = new SessionManager(storage);
  const starts: ExternalRuntimeStartRequest[] = [];
  const workspaceRequests: Array<{ sessionId: string; requestedCwd: unknown }> = [];
  const sends: Array<{
    sessionId: string;
    input: DesktopExternalRuntimeTurnInput;
    owner?: number;
    goalContinuation?: { goalId: string; revision: number };
    hooks?: ExternalRuntimeSubmissionHooks;
  }> = [];
  const sent = deferred<void>();
  const completion = deferred<ExternalRuntimeTurnOutcome>();
  finishers.push(() => completion.resolve({ ok: true, reason: "completed", streamed: true }));
  let ownerClosed = false;
  let ownerLookups = 0;
  let busy = options.busy === true;
  let runtimeExists = false;
  let workspaceRevoked = false;
  const owner = {
    webContents: { id: 57 },
    isDestroyed: () => ownerClosed,
  } as BrowserWindow;
  const fake = {
    get: () => (runtimeExists ? {} : undefined),
    isSessionRunning: () => busy,
    ensureContinuation: async (request: ExternalRuntimeStartRequest) => {
      starts.push(request);
      options.duringEnsure?.();
      request.assertStartAuthority?.();
      if (options.ensureFailure) throw options.ensureFailure;
      return {};
    },
    send: (
      sessionId: string,
      input: DesktopExternalRuntimeTurnInput,
      callerWebContentsId?: number,
      goalContinuation?: { goalId: string; revision: number },
      hooks?: ExternalRuntimeSubmissionHooks,
    ) => {
      sends.push({ sessionId, input, owner: callerWebContentsId, goalContinuation, hooks });
      sent.resolve();
      return completion.promise;
    },
    stop: async () => undefined,
  };
  let currentService: ExternalRuntimeService | null = fake as unknown as ExternalRuntimeService;
  const submit = createExternalRuntimeHostSubmission({
    sessions,
    service: () => currentService,
    resolveStartWorkspace: async (sessionId, requestedCwd) => {
      workspaceRequests.push({ sessionId, requestedCwd });
      if (options.workspaceFailure) throw options.workspaceFailure;
      const existed = sessions.exists(sessionId);
      const mainRoot = options.resolvedWorkspace?.mainRoot ?? String(requestedCwd);
      const cwd =
        options.resolvedWorkspace?.cwd ?? sessions.getSessionWorkspace(sessionId)?.root ?? mainRoot;
      return {
        cwd,
        mainRoot,
        assertStartAuthority: () => {
          if (
            workspaceRevoked ||
            (existed && !sessions.exists(sessionId)) ||
            (sessions.exists(sessionId) &&
              (sessions.readSessionMainRoot(sessionId) !== mainRoot ||
                sessions.getSessionWorkspace(sessionId)?.root !== cwd))
          )
            throw new Error("External runtime Session workspace changed before startup");
        },
      };
    },
    ownerWindow: () => {
      ownerLookups++;
      return options.hasOwner === false ? undefined : owner;
    },
  });
  return {
    submit,
    sessions,
    starts,
    workspaceRequests,
    sends,
    sent: sent.promise,
    complete: completion.resolve,
    fail: completion.reject,
    async accept() {
      await sent.promise;
      await sends[0]!.hooks!.beforeInput();
      sends[0]!.hooks!.accepted();
    },
    setBusy: (value: boolean) => (busy = value),
    setLive: (value: boolean) => (runtimeExists = value),
    closeOwner: () => (ownerClosed = true),
    clearService: () => (currentService = null),
    revokeWorkspace: () => (workspaceRevoked = true),
    ownerLookups: () => ownerLookups,
  };
}

const NEW_RUN = {
  sessionId: "delegated-codex",
  cwd: "/authorized/project",
  model: "codex/gpt-6.1-sol",
  task: "Inspect the supplied files",
  displayText: "用户原始请求",
  clientMessageId: "im-work:wechat:message-1",
};

const SELECTED_WORKTREE = {
  kind: "worktree" as const,
  root: "/selected/worktree",
  worktree: {
    path: "/selected/worktree",
    branch: "codex/selected-worktree",
    baseRef: "main",
    createdBy: "codeshell" as const,
  },
};

describe("Main-originated external runtime submissions", () => {
  test("preserves Codex selection, attachments and Goal and acknowledges only durable acceptance", async () => {
    const f = harness();
    const goal: GoalConfig = {
      goalId: "goal-1",
      revision: 3,
      objective: "Inspect the supplied files and report verified results",
      tokenBudget: 20_000,
    };
    const attachments: InputAttachmentMeta[] = [
      {
        id: "image-one",
        sessionId: NEW_RUN.sessionId,
        kind: "image",
        origin: "im-gateway",
        path: ".code-shell/attachments/image-one.png",
        absPath: "/authorized/project/.code-shell/attachments/image-one.png",
        mime: "image/png",
        size: 16,
        sha256: "fixture-image-hash",
        createdAt: 1,
      },
      {
        id: "file-one",
        sessionId: NEW_RUN.sessionId,
        kind: "file",
        origin: "im-gateway",
        path: ".code-shell/attachments/report.txt",
        absPath: "/authorized/project/.code-shell/attachments/report.txt",
        mime: "text/plain",
        size: 12,
        sha256: "fixture-file-hash",
        createdAt: 2,
      },
    ];
    let settled = false;
    const result = f.submit.run({
      ...NEW_RUN,
      attachments,
      goal,
      permissionMode: "default",
      planMode: false,
      workspaceProfile: "researcher",
    });
    void result.then(() => {
      settled = true;
    });
    await f.sent;
    expect(settled).toBe(false);
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]).toMatchObject({
      kind: "codex",
      sessionId: NEW_RUN.sessionId,
      cwd: NEW_RUN.cwd,
      mainRoot: NEW_RUN.cwd,
      modelKey: NEW_RUN.model,
      model: "gpt-6.1-sol",
      permissionMode: "default",
      planMode: false,
      workspaceProfile: "researcher",
    });
    expect(f.starts[0]!.ownerWindow?.webContents.id).toBe(57);
    expect(f.sends[0]).toMatchObject({
      sessionId: NEW_RUN.sessionId,
      input: {
        text: NEW_RUN.task,
        displayText: NEW_RUN.displayText,
        clientMessageId: NEW_RUN.clientMessageId,
        goal,
        modelTraceSource: "im-work-external",
        attachments: [
          { path: attachments[0]!.absPath, kind: "image", mime: "image/png" },
          { path: attachments[1]!.absPath, kind: "file", mime: "text/plain" },
        ],
      },
    });
    await f.accept();
    expect(await result).toEqual({ ok: true });
    // Completion is deliberately still pending: the helper acknowledges an
    // admitted input while the service owns the eventual transcript and stream.
    expect(settled).toBe(true);
    expect(f.starts).toHaveLength(1);
    expect(f.sends).toHaveLength(1);
    f.complete({ ok: true, reason: "completed", streamed: true, text: "Verified result" });
    await Promise.resolve();
    expect(await result).toEqual({ ok: true });
  });

  test("a cold persisted Claude Session retains its model and cwd for a bound reply", async () => {
    const f = harness({ hasOwner: false });
    f.sessions.create(
      "/persisted/claude-project",
      "claude-code/opus",
      "claude-code",
      "bound-claude",
    );
    expect(f.submit.isExternal("bound-claude")).toBe(true);
    expect(f.submit.isRunning("bound-claude")).toBe(false);
    const result = f.submit.runBound({
      sessionId: "bound-claude",
      text: "继续刚才的工作",
      clientMessageId: "im-session:visit-one:wechat-message",
    });
    await f.sent;
    expect(f.starts[0]).toMatchObject({
      kind: "claude-code",
      modelKey: "claude-code/opus",
      model: "opus",
      cwd: "/persisted/claude-project",
      mainRoot: "/persisted/claude-project",
    });
    expect(f.starts[0]!.ownerWindow).toBeUndefined();
    expect(f.sends[0]!.input).toMatchObject({
      text: "继续刚才的工作",
      displayText: "继续刚才的工作",
      clientMessageId: "im-session:visit-one:wechat-message",
    });
    await f.accept();
    expect(await result).toEqual({ started: true });
  });

  test.each([
    ["codex", "codex/gpt-6.1-sol"],
    ["claude-code", "claude-code/opus"],
  ])(
    "a persisted %s worktree keeps its execution root and canonical project",
    async (kind, model) => {
      const f = harness({ hasOwner: false });
      const sessionId = `bound-worktree-${kind}`;
      f.sessions.create("/persisted/main-project", model, kind, sessionId);
      f.sessions.setSessionWorkspace(sessionId, SELECTED_WORKTREE);
      const result = f.submit.runBound({
        sessionId,
        text: "Continue in the selected workspace",
        clientMessageId: `${sessionId}:followup`,
      });
      await f.sent;
      expect(f.workspaceRequests).toEqual([{ sessionId, requestedCwd: "/persisted/main-project" }]);
      expect(f.starts[0]).toMatchObject({
        kind,
        modelKey: model,
        cwd: "/selected/worktree",
        mainRoot: "/persisted/main-project",
      });
      await f.accept();
      expect(await result).toEqual({ started: true });
      expect(f.sessions.readSessionState(sessionId)?.cwd).toBe("/persisted/main-project");
    },
  );

  test("a new Session uses the resolver's canonical workspace and project roots", async () => {
    const f = harness({
      resolvedWorkspace: { cwd: "/canonical/project", mainRoot: "/canonical/project" },
      duringEnsure: () => {
        f.sessions.create("/canonical/project", NEW_RUN.model, "codex", NEW_RUN.sessionId);
      },
    });
    const result = f.submit.run(NEW_RUN);
    await f.sent;
    expect(f.workspaceRequests).toEqual([
      { sessionId: NEW_RUN.sessionId, requestedCwd: NEW_RUN.cwd },
    ]);
    expect(f.starts[0]).toMatchObject({
      cwd: "/canonical/project",
      mainRoot: "/canonical/project",
    });
    await f.accept();
    expect(await result).toEqual({ ok: true });
  });

  test("workspace resolution failure never starts or sends a replacement run", async () => {
    const f = harness({ workspaceFailure: new Error("Session workspace unavailable") });
    expect(await f.submit.run(NEW_RUN)).toEqual({
      ok: false,
      message: "Session workspace unavailable",
    });
    expect(f.starts).toEqual([]);
    expect(f.sends).toEqual([]);
  });

  test("a persisted workspace change during ensure revokes startup without sending", async () => {
    const sessionId = "worktree-changed-during-start";
    const f = harness({
      duringEnsure: () => {
        f.sessions.setSessionWorkspace(sessionId, { kind: "main", root: "/persisted/main" });
      },
    });
    f.sessions.create("/persisted/main", NEW_RUN.model, "codex", sessionId);
    f.sessions.setSessionWorkspace(sessionId, SELECTED_WORKTREE);
    expect(
      await f.submit.runBound({ sessionId, text: "Continue", clientMessageId: "workspace-race" }),
    ).toMatchObject({ started: false, reason: expect.stringContaining("workspace changed") });
    expect(f.starts).toHaveLength(1);
    expect(f.sends).toEqual([]);
  });

  test("new Session startup also retains the workspace authority fence", async () => {
    const f = harness({ duringEnsure: () => f.revokeWorkspace() });
    expect(await f.submit.run(NEW_RUN)).toMatchObject({
      ok: false,
      message: expect.stringContaining("workspace changed"),
    });
    expect(f.starts).toHaveLength(1);
    expect(f.sends).toEqual([]);
  });

  test("provider identity remains fenced when workspace authority is unchanged", async () => {
    const f = harness({
      duringEnsure: () => {
        f.sessions.updateSessionState(NEW_RUN.sessionId, {
          provider: "claude-code",
          model: "claude-code/opus",
        });
      },
    });
    f.sessions.create(NEW_RUN.cwd, NEW_RUN.model, "codex", NEW_RUN.sessionId);
    expect(await f.submit.run(NEW_RUN)).toMatchObject({
      ok: false,
      message: expect.stringContaining("模型或工作目录已改变"),
    });
    expect(f.sends).toEqual([]);
  });

  test("a new Session cannot adopt another provider while retaining the authorized workspace", async () => {
    const f = harness({
      duringEnsure: () => {
        f.sessions.create(NEW_RUN.cwd, "claude-code/opus", "claude-code", NEW_RUN.sessionId);
      },
    });
    expect(await f.submit.run(NEW_RUN)).toMatchObject({
      ok: false,
      message: expect.stringContaining("模型或工作目录已改变"),
    });
    expect(f.sends).toEqual([]);
  });

  test("workspace authority is checked again immediately before accepting input", async () => {
    const f = harness();
    const result = f.submit.run(NEW_RUN);
    await f.sent;
    f.revokeWorkspace();
    let rejected: unknown;
    try {
      await f.sends[0]!.hooks!.beforeInput();
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toContain("workspace changed");
    f.fail(rejected);
    expect(await result).toMatchObject({ ok: false });
    expect(f.starts).toHaveLength(1);
    expect(f.sends).toHaveLength(1);
  });

  test("a string Goal reaches the external service unchanged", async () => {
    const f = harness();
    const result = f.submit.run({ ...NEW_RUN, goal: "Finish this exact objective" });
    await f.sent;
    expect(f.sends[0]!.input.goal).toBe("Finish this exact objective");
    await f.accept();
    expect(await result).toEqual({ ok: true });
  });

  test("Goal continuation and suppression controls do not replace the persisted objective", async () => {
    const f = harness();
    f.sessions.create("/persisted/project", NEW_RUN.model, "codex", NEW_RUN.sessionId);
    const continuation = { goalId: "existing-goal", revision: 9 };
    const result = f.submit.run({
      ...NEW_RUN,
      requireExisting: true,
      goalContinuation: continuation,
      disableGoal: true,
    });
    await f.sent;
    expect(f.sends[0]!.goalContinuation).toEqual(continuation);
    expect(f.sends[0]!.input.disableGoal).toBe(true);
    expect(f.sends[0]!.input.goal).toBeUndefined();
    await f.accept();
    expect(await result).toEqual({ ok: true });
  });

  test("canonical model normalization during ensure preserves a cold legacy Session", async () => {
    const f = harness({
      duringEnsure: () => {
        f.sessions.updateSessionState("legacy-claude", { model: "claude-code/opus" });
      },
    });
    f.sessions.create("/legacy/project", "opus", "claude-code", "legacy-claude");
    const result = f.submit.runBound({
      sessionId: "legacy-claude",
      text: "Continue the existing legacy thread",
      clientMessageId: "legacy-thread-followup",
    });
    await f.sent;
    expect(f.starts[0]!.modelKey).toBe("claude-code/opus");
    await f.accept();
    expect(await result).toEqual({ started: true });
  });

  test("initial handoff reads the supplied SessionManager's actual storage", async () => {
    const f = harness();
    const bundle = f.sessions.create("/stored/project", NEW_RUN.model, "codex", "stored-thread");
    bundle.transcript.append("message", {
      role: "user",
      content: "The unfinished constraint belongs to this stored work thread",
    });
    const result = f.submit.runBound({
      sessionId: "stored-thread",
      text: "Continue without losing my constraint",
      clientMessageId: "stored-thread-followup",
    });
    await f.sent;
    expect(f.starts[0]!.initialContext).toContain(
      "The unfinished constraint belongs to this stored work thread",
    );
    await f.accept();
    expect(await result).toEqual({ started: true });
  });

  test("a busy external Session refuses before ensure or send without acknowledging a memory queue", async () => {
    const f = harness({ busy: true });
    f.sessions.create("/persisted/project", "codex/gpt-6.1-sol", "codex", "bound-busy");
    const result = await f.submit.runBound({
      sessionId: "bound-busy",
      text: "A successor for the current turn",
      clientMessageId: "im-session:busy:next",
    });
    expect(result.started).toBe(false);
    expect(result.reason).toContain("未切换到 API");
    expect(f.starts).toEqual([]);
    expect(f.sends).toEqual([]);
    expect(f.ownerLookups()).toBe(0);
    expect(f.workspaceRequests).toEqual([]);
  });

  test.each(["codex/", "claude-code/", "openrouter/gpt-6.1-sol", ""])(
    "invalid explicit model %s does not infer a replacement from persisted state",
    async (model) => {
      const f = harness();
      f.sessions.create("/persisted/project", "codex/gpt-6.1-sol", "codex", NEW_RUN.sessionId);
      const result = await f.submit.run({ ...NEW_RUN, model });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("模型配置无效");
      expect(f.starts).toEqual([]);
      expect(f.sends).toEqual([]);
    },
  );

  test("missing model and missing original bound Session never trigger inference", async () => {
    const f = harness();
    expect(
      await f.submit.run({
        sessionId: "no-model",
        cwd: "/project",
        task: "Must not infer a default",
      }),
    ).toMatchObject({ ok: false });
    expect(await f.submit.run({ ...NEW_RUN, requireExisting: true })).toMatchObject({
      ok: false,
      message: "原工作会话不存在。",
    });
    expect(f.starts).toEqual([]);
    expect(f.sends).toEqual([]);
  });

  test("ensure failure returns the external error and never submits a replacement run", async () => {
    const f = harness({ ensureFailure: new Error("Codex login required") });
    expect(await f.submit.run(NEW_RUN)).toEqual({ ok: false, message: "Codex login required" });
    expect(f.starts).toHaveLength(1);
    expect(f.sends).toEqual([]);
  });

  test("native persisted identity overrides a stale live external runtime", async () => {
    const f = harness();
    f.setLive(true);
    f.sessions.create("/native/project", "gpt-6.1-sol", "openai", "native-owned");
    expect(f.submit.isExternal("native-owned")).toBe(false);
    expect(f.submit.isExternal("unpersisted-live-runtime")).toBe(true);
    const result = await f.submit.runBound({
      sessionId: "native-owned",
      text: "Do not resurrect stale Codex ownership",
      clientMessageId: "im-session:native:one",
    });
    expect(result.started).toBe(false);
    expect(f.starts).toEqual([]);
    expect(f.sends).toEqual([]);
  });

  test("external completion before acceptance reports failure without retry or provider fallback", async () => {
    const f = harness();
    const result = f.submit.run(NEW_RUN);
    await f.sent;
    f.complete({
      ok: false,
      reason: "model_error",
      streamed: true,
      text: "External quota exceeded",
    });
    expect(await result).toEqual({ ok: false, message: "External quota exceeded" });
    expect(f.starts).toHaveLength(1);
    expect(f.sends).toHaveLength(1);
  });

  test("a provider failure after acceptance stays owned by the asynchronous external lifecycle", async () => {
    const f = harness();
    const result = f.submit.run(NEW_RUN);
    await f.accept();
    expect(await result).toEqual({ ok: true });
    f.fail(new Error("External output stream failed after admission"));
    await Promise.resolve();
    await Promise.resolve();
    expect(await result).toEqual({ ok: true });
    expect(f.starts).toHaveLength(1);
    expect(f.sends).toHaveLength(1);
  });

  test("a destroyed owner rejects startup before sending", async () => {
    const f = harness();
    f.closeOwner();
    expect(await f.submit.run(NEW_RUN)).toMatchObject({ ok: false });
    expect(f.sends).toEqual([]);
  });

  test("submission authority is rechecked before accepting input after service replacement", async () => {
    const f = harness();
    const result = f.submit.run(NEW_RUN);
    await f.sent;
    f.clearService();
    let rejected: unknown;
    try {
      await f.sends[0]!.hooks!.beforeInput();
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    f.fail(rejected);
    expect(await result).toMatchObject({ ok: false });
    expect(f.sends).toHaveLength(1);
  });
});
