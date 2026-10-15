import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentServer,
  ChatSessionManager,
  createInProcessTransport,
  type Engine,
} from "@cjhyy/code-shell-core";
import { getInteractiveApprovalBackend } from "@cjhyy/code-shell-core/internal";
import { createDesktopWorkerHost, type DesktopWorkerHostHandlers } from "./worker-host-runtime.js";

const hosts: ReturnType<typeof createDesktopWorkerHost>[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.runtime.stop();
});

type Route = Exclude<keyof DesktopWorkerHostHandlers, "sendLine">;

function fixture() {
  const handled: { route: Route; line: string }[] = [];
  const workerReplies: string[] = [];
  const clientLines: string[] = [];
  const route = (name: Route) => (line: string) => {
    handled.push({ route: name, line });
    return true;
  };
  const host = createDesktopWorkerHost({
    operationBatch: route("operationBatch"),
    credentials: route("credentials"),
    browser: route("browser"),
    credentialCookie: route("credentialCookie"),
    workspace: route("workspace"),
    panel: route("panel"),
    automation: route("automation"),
    sendLine: (line) => workerReplies.push(line),
  });
  hosts.push(host);
  return {
    host,
    handled,
    workerReplies,
    clientLines,
    deliver(line: string) {
      // AgentBridge forwards only lines the production adapter did not consume.
      const intercepted = host.intercept(line);
      if (!intercepted) clientLines.push(line);
      return intercepted;
    },
  };
}

function approval(toolName: string, args: Record<string, unknown> = {}) {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/approvalRequest",
    params: {
      sessionId: "desktop-session",
      requestId: "private-worker-request",
      connectionId: "desktop-connection",
      generation: 7,
      request: { toolName, args },
    },
  });
}

describe("Desktop worker Host adapter", () => {
  test.each([
    "credentialResolve",
    "credentialMaterializeCookie",
    "oauthAccessResolve",
    "remoteLinkAction",
    "localOAuthLinkAction",
    "modelRequestSign",
  ])("keeps supported desktop/%s on the existing credential authority", (method) => {
    const f = fixture();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: "authority-private-id",
      method: `desktop/${method}`,
      params: { id: "fixture-credential" },
    });
    expect(f.deliver(line)).toBe(true);
    expect(f.handled).toEqual([{ route: "credentials", line }]);
    expect(f.workerReplies).toEqual([]);
    expect(f.clientLines).toEqual([]);
  });

  test.each([
    ["desktop/automationCreate", "automation"],
    ["desktop/operationBatch", "operationBatch"],
  ] as const)("keeps supported %s requests on their Desktop authority", (method, route) => {
    const f = fixture();
    const line = JSON.stringify({ jsonrpc: "2.0", id: 0, method, params: {} });
    expect(f.deliver(line)).toBe(true);
    expect(f.handled).toEqual([{ route, line }]);
    expect(f.workerReplies).toEqual([]);
    expect(f.clientLines).toEqual([]);
  });

  test.each([
    ["__browser_action__", "browser", { action: "snapshot" }],
    ["__credential_action__", "credentialCookie", { action: "injectCookie" }],
    ["__workspace_action__", "workspace", { action: "resolve_session_run" }],
    ["__panel_action__", "panel", { action: "list" }],
  ] as const)("routes supported %s privately without an unsupported reply", (tool, route, args) => {
    const f = fixture();
    const line = approval(tool, args);
    expect(f.deliver(line)).toBe(true);
    // The complete original line retains child/connection/session routing data.
    expect(f.handled).toEqual([{ route, line }]);
    expect(f.workerReplies).toEqual([]);
    expect(f.clientLines).toEqual([]);
  });

  test("consumes batch readiness and OAuth cancellation notifications without JSON-RPC replies", () => {
    const f = fixture();
    const ready = JSON.stringify({
      jsonrpc: "2.0",
      method: "desktop/operationBatch",
      params: { phase: "ready", version: 1 },
    });
    const cancel = JSON.stringify({
      jsonrpc: "2.0",
      method: "desktop/localOAuthLinkActionCancel",
      params: { requestId: "oauth-private-request" },
    });
    expect(f.deliver(ready)).toBe(true);
    expect(f.deliver(cancel)).toBe(true);
    expect(f.handled).toEqual([
      { route: "operationBatch", line: ready },
      { route: "credentials", line: cancel },
    ]);
    expect(f.workerReplies).toEqual([]);
    expect(f.clientLines).toEqual([]);
  });

  test.each([
    ["desktop/credentialResolve", "credentials"],
    ["desktop/credentialMaterializeCookie", "credentials"],
    ["desktop/oauthAccessResolve", "credentials"],
    ["desktop/remoteLinkAction", "credentials"],
    ["desktop/localOAuthLinkAction", "credentials"],
    ["desktop/modelRequestSign", "credentials"],
    ["desktop/automationCreate", "automation"],
  ] as const)("keeps legacy %s frames without an id private", (method, route) => {
    const f = fixture();
    const line = JSON.stringify({ jsonrpc: "2.0", method, params: {} });
    expect(f.deliver(line)).toBe(true);
    expect(f.handled).toEqual([{ route, line }]);
    expect(f.workerReplies).toEqual([]);
    expect(f.clientLines).toEqual([]);
  });

  test("leaves ordinary tool approvals, synchronous AskUser and asynchronous AskUser to clients", () => {
    const f = fixture();
    const tool = approval("Bash", { command: "printf fixture" });
    const ask = approval("__ask_user__", { question: "Choose a fixture option" });
    const asynchronous = approval("__ask_user__", {
      question: "Choose a fixture option later",
      asynchronous: true,
    });
    const lines = [tool, ask, asynchronous];
    for (const line of lines) expect(f.deliver(line)).toBe(false);
    expect(f.clientLines).toEqual(lines);
    expect(f.handled).toEqual([]);
    expect(f.workerReplies).toEqual([]);
  });

  test.each(["private-authority-id", 0])(
    "rejects an unknown desktop request immediately and never forwards its id (%s)",
    (id) => {
      const f = fixture();
      const method = "desktop/futureCapability";
      expect(f.deliver(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }))).toBe(true);
      expect(f.handled).toEqual([]);
      expect(f.clientLines).toEqual([]);
      expect(f.workerReplies.map((line) => JSON.parse(line))).toEqual([
        {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `${method} is not supported by this host (Desktop)`,
            data: { failure: "unsupported", capability: method },
          },
        },
      ]);
    },
  );

  test("settles an unknown internal loopback as unsupported without exposing its private id", () => {
    const f = fixture();
    expect(f.deliver(approval("__future_action__"))).toBe(true);
    expect(f.clientLines).toEqual([]);
    expect(f.handled).toEqual([]);
    const response = JSON.parse(f.workerReplies[0]);
    expect(response.id).toStartWith("desktop-host-approve-");
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      method: "agent/approve",
      params: {
        sessionId: "desktop-session",
        requestId: "private-worker-request",
        connectionId: "desktop-connection",
        generation: 7,
        decision: { approved: true },
      },
    });
    expect(JSON.parse(response.params.decision.answer)).toMatchObject({
      ok: false,
      failure: "unsupported",
      capability: "__future_action__",
      detail: "__future_action__ is not supported by this host (Desktop)",
    });
    expect(f.workerReplies).toHaveLength(1);
  });

  test("Core consumes generated unsupported replies and clears the real pending approvals", async () => {
    const [serverTransport, desktopTransport] = createInProcessTransport();
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({ isHeadless: () => false, setAskUser() {}, dispose() {} }) as unknown as Engine,
    });
    const server = new AgentServer({ transport: serverTransport, chatManager: manager });
    const replies: any[] = [];
    const acknowledgements: any[] = [];
    const clientLines: string[] = [];
    const pendingRequestIds: string[] = [];
    const handled = () => true;
    const host = createDesktopWorkerHost({
      operationBatch: handled,
      credentials: handled,
      browser: handled,
      credentialCookie: handled,
      workspace: handled,
      panel: handled,
      automation: handled,
      sendLine(line) {
        const reply = JSON.parse(line);
        replies.push(reply);
        desktopTransport.send(reply);
      },
    });
    hosts.push(host);
    desktopTransport.onMessage((message) => {
      if ("id" in message && "result" in message) acknowledgements.push(message);
      if ("method" in message && message.method === "agent/approvalRequest") {
        const params = message.params as { sessionId: string; requestId: string };
        expect(manager.get(params.sessionId)?.pendingApprovals.has(params.requestId)).toBe(true);
        pendingRequestIds.push(params.requestId);
      }
      const line = JSON.stringify(message);
      if (!host.intercept(line)) clientLines.push(line);
    });
    try {
      const session = await manager.getOrCreate("desktop-unsupported-session", {});
      for (const capability of ["__future_action__", "__other_future_action__"]) {
        const decision = await getInteractiveApprovalBackend().requestApproval({
          sessionId: session.id,
          toolName: capability,
          args: {},
          description: "fixture host operation",
          riskLevel: "low",
        });
        expect(decision.approved).toBe(true);
        expect(JSON.parse(decision.answer!)).toMatchObject({
          ok: false,
          failure: "unsupported",
          capability,
          detail: `${capability} is not supported by this host (Desktop)`,
        });
        expect(session.pendingApprovals.size).toBe(0);
        expect((server as any).approvalTimers.size).toBe(0);
        expect((server as any).pendingApprovalTargets.size).toBe(0);
      }
      // Missing ids used to make isRequest discard these frames, leaving the
      // promise and its five-minute timer pending. Assert real Core acks too.
      expect(replies).toHaveLength(2);
      expect(new Set(replies.map((reply) => reply.id)).size).toBe(2);
      expect(acknowledgements).toEqual(
        replies.map((reply) => ({ jsonrpc: "2.0", id: reply.id, result: { ok: true } })),
      );
      expect(pendingRequestIds).toHaveLength(2);
      for (const requestId of pendingRequestIds)
        expect(clientLines.some((line) => line.includes(requestId))).toBe(false);
      expect(clientLines.some((line) => line.includes("__future_action__"))).toBe(false);
      expect(clientLines.some((line) => line.includes("__other_future_action__"))).toBe(false);
    } finally {
      server.close();
      desktopTransport.close();
      await manager.closeAllAsync();
    }
  });

  test("leaves stream frames and malformed JSON on the ordinary line path", () => {
    const f = fixture();
    const lines = [
      JSON.stringify({ method: "agent/streamEvent", params: { event: { type: "text" } } }),
      "not-json",
    ];
    for (const line of lines) expect(f.deliver(line)).toBe(false);
    expect(f.clientLines).toEqual(lines);
    expect(f.handled).toEqual([]);
    expect(f.workerReplies).toEqual([]);
  });
});
