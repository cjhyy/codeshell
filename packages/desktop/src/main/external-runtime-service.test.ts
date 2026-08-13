/**
 * Desktop is the layer that resolves the security-relevant inputs, so these tests
 * are about the DECISIONS it makes, not about driving a real runtime.
 *
 * `startExternalRuntimeSession` is stubbed via module mocking, because the point
 * here is what Desktop passes down — not whether a Codex binary is installed.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type StartArgs = Record<string, unknown>;
const starts: StartArgs[] = [];
const closed: string[] = [];

/** A session stub that records what it was asked to do. */
function fakeSession(args: StartArgs) {
  return {
    kind: args.kind,
    businessSessionId: args.businessSessionId,
    runtimeSessionId: "runtime-1",
    listTools: () => {
      const exposure = args.exposure as { toolNames?: Set<string> } | undefined;
      // Mirror the real host: only allowlisted names are exposed.
      const names = exposure ? [...(exposure.toolNames ?? [])] : ["Panel"];
      return names.map((name) => ({ name, description: "", inputSchema: {} }));
    },
    send: async () => ({ done: Promise.resolve() }),
    interrupt: async () => {},
    close: async () => {
      closed.push(String(args.businessSessionId));
    },
  };
}

mock.module("@cjhyy/code-shell-capability-coding/external-runtimes", () => ({
  startExternalRuntimeSession: async (args: StartArgs) => {
    starts.push(args);
    return fakeSession(args);
  },
  textWithAttachmentReferences: (input: { text: string; attachments?: Array<{ path: string }> }) =>
    [input.text, ...(input.attachments ?? []).map((attachment) => attachment.path)].join("\n"),
}));

let trust: "trusted" | "untrusted" = "trusted";

const { ExternalRuntimeService } = await import("./external-runtime-service.js");

const claims: Array<{ sessionId: string; webContentsId?: number }> = [];
const released: string[] = [];
const emitted: Array<{ sessionId: string; type: string; eventSessionId?: string }> = [];

function service(
  flags: Record<string, boolean>,
  requestApproval?: () => Promise<{ approved: boolean; answer?: string }>,
  overrides: Record<string, unknown> = {},
) {
  return new ExternalRuntimeService({
    featureFlags: () => flags as never,
    registerSession: (sessionId, _cwd, webContentsId) => claims.push({ sessionId, webContentsId }),
    releaseSession: (sessionId) => released.push(sessionId),
    emit: (sessionId, event) =>
      emitted.push({
        sessionId,
        type: event.type,
        ...(event.type === "session_started" ? { eventSessionId: event.sessionId } : {}),
      }),
    projectTrust: () => trust,
    ...(requestApproval ? { requestApproval } : {}),
    ...overrides,
  });
}

const request = {
  kind: "codex" as const,
  sessionId: "sess-1",
  cwd: "/tmp/project",
  ownerWindow: { webContents: { id: 77 } } as never,
};

beforeEach(() => {
  starts.length = 0;
  closed.length = 0;
  claims.length = 0;
  released.length = 0;
  emitted.length = 0;
  trust = "trusted";
});
afterEach(() => {
  starts.length = 0;
});

describe("ExternalRuntimeService", () => {
  test("refuses to start when the runtime flag is off", async () => {
    // Falling back to the native engine silently would leave a caller debugging
    // the wrong backend.
    const svc = service({ external_agent_runtime: false });
    expect(svc.isEnabled()).toBe(false);
    await expect(svc.start(request)).rejects.toThrow(/disabled|feature flag/i);
    expect(starts).toEqual([]);
  });

  test("exposes NO tools when only the runtime flag is on", async () => {
    // §20 wants the runtime trialable with no tool surface at all: the tool bridge
    // is the part that carries the security burden, so it gets its own flag.
    const svc = service({ external_agent_runtime: true, external_host_tools: false });
    const session = await svc.start(request);
    expect(svc.areHostToolsEnabled()).toBe(false);
    const exposure = starts[0]!.exposure as { toolNames: Set<string> };
    expect([...exposure.toolNames]).toEqual([]);
    expect(session.listTools()).toEqual([]);
  });

  test("uses the reviewed allowlist when host tools are enabled", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    // `undefined` means "the reviewed FIRST_PHASE_EXPOSURE default", which is the
    // safe direction — an explicit set here could only ever be wider.
    expect(starts[0]!.exposure).toBeUndefined();
    const registry = starts[0]!.registry as {
      getToolDefinitions(): Array<{ name: string }>;
    };
    expect(registry.getToolDefinitions().map((tool) => tool.name)).toContain("DriveAgent");
    expect(registry.getToolDefinitions().map((tool) => tool.name)).toContain("DriveAgentJobs");
  });

  test("dontAsk disables approval prompts but preserves user questions", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, async () => ({
      approved: true,
      answer: "answer",
    }));
    await svc.start({ ...request, permissionMode: "dontAsk" });
    expect(starts[0]!.approvalPolicy).toBe("never");
    expect(starts[0]!.approvalBackend).toBeUndefined();
    const hooks = starts[0]!.hooks as Record<string, unknown>;
    expect(hooks.onNativeApproval).toBeUndefined();
    expect(hooks.onUserInput).toBeFunction();
  });

  test("resolves projectTrusted from the trust store, not a default", async () => {
    // `permissions` is the first DANGEROUS_PROJECT_FIELD: an untrusted project's
    // rules must be stripped, and only Desktop knows the answer.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    expect(starts[0]!.projectTrusted).toBe(true);

    trust = "untrusted";
    await svc.start({ ...request, sessionId: "sess-2" });
    expect(starts[1]!.projectTrusted).toBe(false);
  });

  test("claims the panel owner BEFORE starting the runtime", async () => {
    // A Panel tool call on the very first turn would otherwise find no owning
    // window and fail closed (§9.3.2).
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    expect(claims).toEqual([{ sessionId: "sess-1", webContentsId: 77 }]);
  });

  test("fallible preparation happens before the host session is registered", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      toolContextOverrides: () => {
        throw new Error("context setup failed");
      },
    });

    await expect(svc.start(request)).rejects.toThrow(/context setup failed/);
    expect(claims).toEqual([]);
    expect(starts).toEqual([]);
  });

  test("binding sidecar failures do not orphan or fail a live runtime", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      writeBinding: () => {
        throw new Error("sidecar disk full");
      },
    });

    await expect(svc.start(request)).resolves.toBeDefined();
    await expect(svc.send("sess-1", "still runs")).resolves.toMatchObject({ ok: true });
    expect(svc.get("sess-1")).toBeDefined();
    await svc.stop("sess-1");
  });

  test("closes a runtime whose owner window disappeared during startup", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    const ownerWindow = {
      webContents: { id: 77 },
      isDestroyed: () => true,
    } as never;

    await expect(svc.start({ ...request, ownerWindow })).rejects.toThrow(/owner window closed/i);
    expect(closed).toEqual(["sess-1"]);
    expect(released).toEqual(["sess-1"]);
    expect(svc.get("sess-1")).toBeUndefined();
  });

  test("starts without an owner window, leaving invoke to fail closed", async () => {
    // Headless/mobile sessions have no renderer. That must not block the runtime —
    // only Panel.invoke is unavailable, which the bridge reports on its own.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start({ ...request, ownerWindow: undefined });
    // Still registered (the session and its bucket must exist), just with no
    // owner — that is what makes Panel.invoke fail closed rather than broadcast.
    expect(claims).toEqual([{ sessionId: "sess-1", webContentsId: undefined }]);
    expect(starts).toHaveLength(1);
  });

  test("restarting the same session closes the previous one first", async () => {
    // Two runtimes writing one business session would interleave turns.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.start(request);
    expect(closed).toEqual(["sess-1"]);
    expect(starts).toHaveLength(2);
  });

  test("serializes concurrent starts for the same business session", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await Promise.all([svc.start(request), svc.start(request)]);

    expect(starts).toHaveLength(2);
    expect(closed).toEqual(["sess-1"]);
    expect(released).toEqual(["sess-1"]);
  });

  test("another renderer window cannot replace or control an owned session", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const otherWindow = { webContents: { id: 88 } } as never;

    await expect(svc.start({ ...request, ownerWindow: otherWindow })).rejects.toThrow(
      /owned by another window/i,
    );
    await expect(svc.send("sess-1", "hijack", 88)).rejects.toThrow(/owned by another window/i);
    await expect(svc.interrupt("sess-1", 88)).rejects.toThrow(/owned by another window/i);
    await expect(svc.stop("sess-1", 88)).rejects.toThrow(/owned by another window/i);
    expect(svc.get("sess-1")).toBeDefined();
    expect(closed).toEqual([]);
  });

  test("rechecks stop ownership after an in-flight start becomes visible", async () => {
    let queuedStop: Promise<void> | undefined;
    let svc!: ExternalRuntimeService;
    svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      registerSession: () => {
        // Registration happens before the awaited provider start and before the
        // live entry is published. This is the exact gap where the old call-time
        // check saw no owner and allowed another window's stop into the queue.
        queuedStop = svc.stop("sess-1", 88);
      },
    });

    await svc.start(request);
    expect(queuedStop).toBeDefined();
    await expect(queuedStop!).rejects.toThrow(/owned by another window/i);
    expect(svc.get("sess-1")).toBeDefined();
    expect(closed).toEqual([]);
  });

  test("the owning renderer and trusted main-process callers keep control", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);

    await expect(svc.send("sess-1", "owner", 77)).resolves.toMatchObject({ ok: true });
    await expect(svc.interrupt("sess-1", 77)).resolves.toBeUndefined();
    await expect(svc.stop("sess-1")).resolves.toBeUndefined();
  });

  test("a renderer cannot claim an existing ownerless main-process session", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start({ ...request, ownerWindow: undefined });

    await expect(svc.send("sess-1", "hijack", 77)).rejects.toThrow(/owned by another window/i);
    await expect(svc.stop("sess-1", 77)).rejects.toThrow(/owned by another window/i);
    expect(svc.get("sess-1")).toBeDefined();
  });

  test("forwards translated events tagged with the session id", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const hooks = starts[0]!.hooks as { onEvent: (event: { type: string }) => void };
    hooks.onEvent({ type: "text_delta" });
    expect(emitted).toEqual([{ sessionId: "sess-1", type: "text_delta" }]);
  });

  test("normalizes a provider session_started id to the CodeShell business id", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const hooks = starts[0]!.hooks as {
      onEvent: (event: {
        type: "session_started";
        sessionId: string;
        promptTokens: number;
      }) => void;
    };
    hooks.onEvent({ type: "session_started", sessionId: "provider-thread-id", promptTokens: 0 });
    expect(emitted).toEqual([
      { sessionId: "sess-1", type: "session_started", eventSessionId: "sess-1" },
    ]);
  });

  test("drops late events from a runtime after the business session is restarted", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const oldHooks = starts[0]!.hooks as { onEvent: (event: { type: string }) => void };

    await svc.start(request);
    const currentHooks = starts[1]!.hooks as { onEvent: (event: { type: string }) => void };
    emitted.length = 0;
    oldHooks.onEvent({ type: "text_delta" });
    currentHooks.onEvent({ type: "text_delta" });

    expect(emitted).toEqual([{ sessionId: "sess-1", type: "text_delta" }]);
  });

  test("drops provider events emitted while a stopped runtime is closing", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const hooks = starts[0]!.hooks as { onEvent: (event: { type: string }) => void };
    const runtime = svc.get("sess-1") as unknown as { close: () => Promise<void> };
    runtime.close = async () => hooks.onEvent({ type: "text_delta" });

    emitted.length = 0;
    await svc.stop("sess-1");

    expect(emitted).toEqual([]);
  });

  test("records an aborted terminal event when an active turn is stopped", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const runtime = svc.get("sess-1") as unknown as {
      send: () => Promise<{ done: Promise<void> }>;
    };
    let finishTurn!: () => void;
    const done = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    runtime.send = async () => ({ done });

    const sending = svc.send("sess-1", "running");
    await Promise.resolve();
    await svc.stop("sess-1");
    finishTurn();

    await expect(sending).resolves.toMatchObject({
      ok: false,
      reason: "aborted_streaming",
      streamed: true,
    });
    expect(emitted).toEqual([{ sessionId: "sess-1", type: "turn_complete" }]);
  });

  test("serializes overlapping sends before resetting the shared turn recorder", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const runtime = svc.get("sess-1") as unknown as {
      send: (input: { text: string }) => Promise<{ done: Promise<void> }>;
    };
    const sent: string[] = [];
    let finishFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    runtime.send = async (input) => {
      sent.push(input.text);
      return { done: input.text === "first" ? firstDone : Promise.resolve() };
    };

    const first = svc.send("sess-1", "first");
    await Promise.resolve();
    const second = svc.send("sess-1", "second");
    await Promise.resolve();
    expect(sent).toEqual(["first"]);

    finishFirst();
    await Promise.all([first, second]);
    expect(sent).toEqual(["first", "second"]);
  });

  test("a provider turn with no terminal callback is completed only once", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);

    emitted.length = 0;
    const outcome = await svc.send("sess-1", "completed without callback");
    expect(emitted).toEqual([{ sessionId: "sess-1", type: "turn_complete" }]);
    emitted.length = 0;
    await svc.stop("sess-1");

    expect(outcome).toMatchObject({ ok: true, reason: "completed", streamed: true });
    expect(emitted).toEqual([]);
  });

  test("send() on an unknown session is an error, not a silent no-op", async () => {
    const svc = service({ external_agent_runtime: true });
    await expect(svc.send("nope", "hi")).rejects.toThrow(/no external runtime session/i);
  });

  test("stopAll closes every session", async () => {
    // Each session holds a child process and a listening port; neither dies with
    // the parent on Windows.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.start({ ...request, sessionId: "sess-b" });
    await svc.stopAll();
    expect(closed.sort()).toEqual(["sess-b", "sess-1"].sort());
    expect(svc.get("sess-1")).toBeUndefined();
  });

  test("closing one owner window reaps only that window's runtimes", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.start({
      ...request,
      sessionId: "sess-b",
      ownerWindow: { webContents: { id: 88 } } as never,
    });

    await svc.stopOwnedBy(77);

    expect(svc.get("sess-1")).toBeUndefined();
    expect(svc.get("sess-b")).toBeDefined();
    expect(closed).toEqual(["sess-1"]);
  });

  test("stop() on an unknown session is a no-op", async () => {
    const svc = service({ external_agent_runtime: true });
    await expect(svc.stop("ghost")).resolves.toBeUndefined();
  });

  test("stopping releases the host registries", async () => {
    // registerSession touches several registries that different modules own.
    // If release is ever dropped, the browser bucket and the reserved session
    // survive for the life of the process, and a later session reusing the id
    // silently inherits them.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.stop("sess-1");
    expect(released).toEqual(["sess-1"]);
  });

  test("a close() that throws still releases", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const session = svc.get("sess-1") as unknown as { close: () => Promise<void> };
    session.close = () => Promise.reject(new Error("runtime died badly"));
    await expect(svc.stop("sess-1")).rejects.toThrow(/died badly/);
    // The throw propagates (callers should see it), but the leak does not.
    expect(released).toEqual(["sess-1"]);
    expect(svc.get("sess-1")).toBeUndefined();
  });

  test("a release failure still cancels approvals and removes the live session", async () => {
    let cancelled = 0;
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      releaseSession: () => {
        throw new Error("release failed");
      },
      cancelApprovals: () => {
        cancelled += 1;
      },
    });
    await svc.start(request);

    await expect(svc.stop("sess-1")).rejects.toThrow(/release failed/);
    expect(cancelled).toBe(1);
    expect(closed).toEqual(["sess-1"]);
    expect(svc.get("sess-1")).toBeUndefined();
  });

  test("restarting the same session releases before re-registering", async () => {
    // start() closes any previous session for the id; that path must release
    // too, or a restart leaves a stale owner claim pointing at an old window.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.start(request);
    expect(released).toEqual(["sess-1"]);
    expect(claims).toHaveLength(2);
  });
});
