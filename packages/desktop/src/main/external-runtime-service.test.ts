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
mock.module("./trust-store.js", () => ({
  getTrustCachedSync: () => trust,
}));

const { ExternalRuntimeService } = await import("./external-runtime-service.js");

const claims: Array<{ sessionId: string; webContentsId?: number }> = [];
const released: string[] = [];
const emitted: Array<{ sessionId: string; type: string }> = [];

function service(
  flags: Record<string, boolean>,
  requestApproval?: () => Promise<{ approved: boolean; answer?: string }>,
) {
  return new ExternalRuntimeService({
    featureFlags: () => flags as never,
    registerSession: (sessionId, _cwd, webContentsId) => claims.push({ sessionId, webContentsId }),
    releaseSession: (sessionId) => released.push(sessionId),
    emit: (sessionId, event) => emitted.push({ sessionId, type: event.type }),
    ...(requestApproval ? { requestApproval } : {}),
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

  test("forwards translated events tagged with the session id", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const hooks = starts[0]!.hooks as { onEvent: (event: { type: string }) => void };
    hooks.onEvent({ type: "text_delta" });
    expect(emitted).toEqual([{ sessionId: "sess-1", type: "text_delta" }]);
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
