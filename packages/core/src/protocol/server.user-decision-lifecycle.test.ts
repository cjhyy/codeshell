import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "../engine/engine.js";
import { setDefaultCredentialAccess } from "../credentials/access.js";
import { useCredentialTool } from "../credentials/use-credential-tool.js";
import { injectCredentialTool } from "../credentials/inject-credential-tool.js";
import { ToolRegistry } from "../tool-system/registry.js";
import type { AskUserOptions, ToolContext } from "../tool-system/context.js";
import { ApprovalRouter } from "../tool-system/permission.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { Methods, USER_DECISION_TIMEOUT_MS } from "./types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  setDefaultCredentialAccess(null);
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "user-decision-"));
  const manager = new ChatSessionManager({
    runtime: {} as never,
    dataRoot: cwd,
    engineFactory: () => ({ dispose() {}, isHeadless: () => false }) as unknown as Engine,
  });
  const sessionId = "decision-session";
  const session = await manager.getOrCreate(sessionId, {});
  const sent: any[] = [];
  const router = new ApprovalRouter();
  const server = new AgentServer({
    chatManager: manager,
    connectionId: "owner",
    approvalRouter: router,
    sessionDiskRoot: join(cwd, "sessions"),
    transport: { send: (frame) => sent.push(frame), onMessage() {}, close() {} },
  });
  const registration = router.register(sessionId, "owner");
  if (!registration.ok) throw new Error("fixture owner conflict");
  cleanup.push(async () => {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    server,
    session,
    sessionId,
    sent,
    ask: (question: string, options?: AskUserOptions): Promise<string> =>
      (server as any).requestAskUserForSession(session, sessionId, question, options),
    request: () => sent.find((frame) => frame.method === Methods.ApprovalRequest).params,
    approve: (route: any, decision: any, id: string) =>
      (server as any).handleApprove({ jsonrpc: "2.0", id, params: { ...route, decision } }),
    resolutions: () => sent.filter((frame) => frame.method === Methods.ApprovalResolved),
  };
}

function routeOf(request: any) {
  const { connectionId, sessionId, generation, requestId } = request;
  return { connectionId, sessionId, generation, requestId };
}

describe("cross-device user decision lifecycle", () => {
  it("keeps UseCredential alive past its execution timeout while waiting for the same decision", async () => {
    const f = await fixture();
    let materialized = 0;
    const credential = {
      id: "video-login",
      label: "Video login",
      type: "cookie" as const,
      hasSecret: true,
      approvalIdentity: "fixture-record",
    };
    setDefaultCredentialAccess({
      listMasked: () => [credential],
      resolveMeta: () => credential,
      envExposures: () => ({}),
      materializeCookie: async () => {
        materialized++;
        return { cookiesFile: "/tmp/fixture-cookie", count: 1 };
      },
    });
    const registry = new ToolRegistry({ builtinTools: ["UseCredential"] });
    const result = registry.executeTool(
      "UseCredential",
      { id: credential.id },
      {
        timeoutMs: 25,
        ctx: {
          cwd: f.cwd,
          settingsScope: "project",
          sessionId: f.sessionId,
          askUser: f.ask,
        } as ToolContext,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 70));
    const request = f.request();
    expect(request.expiresAt).toBe(
      f.session.pendingApprovals.get(request.requestId)!.metadata.expiresAt,
    );
    expect(f.session.pendingApprovals.size).toBe(1);
    expect(materialized).toBe(0);
    expect(request.request.args.signal).toBeUndefined();
    await f.approve(routeOf(request), { approved: true, answer: "允许本次" }, "desktop");
    expect(await result).toMatchObject({ isError: false });
    expect(materialized).toBe(1);
    expect(f.resolutions()).toHaveLength(1);
    expect(f.resolutions()[0].params).toMatchObject({
      ...routeOf(request),
      approved: true,
      answer: "允许本次",
    });
  });

  it("cancels the owning tool's question and rejects a later approval from another device", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let operated = false;
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(
      {
        name: "ConfirmOperation",
        description: "confirmation fixture",
        source: "builtin",
        inputSchema: { type: "object", properties: {} },
      },
      async (_args, ctx) => {
        const answer = await ctx!.askUser!("Proceed?");
        ctx!.signal!.throwIfAborted();
        operated = answer === "yes";
        return "done";
      },
    );
    const result = registry.executeTool(
      "ConfirmOperation",
      {},
      {
        signal: controller.signal,
        ctx: { askUser: f.ask } as ToolContext,
      },
    );
    const request = f.request();
    controller.abort();
    expect(await result).toMatchObject({ isError: true });
    expect(f.session.pendingApprovals.size).toBe(0);
    expect((f.server as any).approvalTimers.size).toBe(0);
    await f.approve(routeOf(request), { approved: true, answer: "yes" }, "late-phone");
    expect(f.sent.find((frame) => frame.id === "late-phone").error).toBeDefined();
    expect(operated).toBe(false);
    expect(f.resolutions()).toHaveLength(1);
    expect(f.resolutions()[0].params).toMatchObject({
      ...routeOf(request),
      approved: false,
      status: "cancelled",
    });
  });

  it.each(["use", "inject"] as const)(
    "preserves the %s credential confirmation's expiry instead of reporting a user denial",
    async (operation) => {
      const f = await fixture();
      let secretAccesses = 0;
      const credential = {
        id: "expiry-login",
        label: "Login",
        type: "cookie" as const,
        hasSecret: true,
        approvalIdentity: "expiry-record",
      };
      setDefaultCredentialAccess({
        listMasked: () => [credential],
        resolveMeta: () => credential,
        envExposures: () => ({}),
        materializeCookie: async () => {
          secretAccesses++;
          return { cookiesFile: "/tmp/unused", count: 1 };
        },
      });
      const ctx = {
        cwd: f.cwd,
        settingsScope: "project",
        sessionId: f.sessionId,
        askUser: f.ask,
        injectCredentialToBrowser: async () => {
          secretAccesses++;
          return { ok: true, count: 1 };
        },
      } as ToolContext;
      const result = (operation === "use" ? useCredentialTool : injectCredentialTool)(
        { id: credential.id },
        ctx,
      );
      const request = f.request();
      const observed = result.then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      );
      const clock = spyOn(Date, "now").mockReturnValue(request.expiresAt);
      try {
        await f.approve(routeOf(request), { approved: true, answer: "允许本次" }, "too-late");
      } finally {
        clock.mockRestore();
      }
      expect((await observed).error).toMatchObject({
        name: "UserDecisionError",
        failure: "timed_out",
      });
      expect(secretAccesses).toBe(0);
      expect(request.request.args.throwOnFailure).toBeUndefined();
      expect(f.resolutions()[0].params).toMatchObject({ approved: false, failure: "timed_out" });
    },
  );

  it("expires at the server deadline even when its timer has not had a turn to run", async () => {
    const f = await fixture();
    const askedAt = Date.now();
    const answer = f.ask("Proceed?");
    const request = f.request();
    expect(request.expiresAt - askedAt).toBeGreaterThanOrEqual(USER_DECISION_TIMEOUT_MS);
    const clock = spyOn(Date, "now").mockReturnValue(request.expiresAt);
    try {
      await f.approve(routeOf(request), { approved: true, answer: "yes" }, "expired-phone");
    } finally {
      clock.mockRestore();
    }
    expect(await answer).toContain("No permission was granted");
    expect(f.sent.find((frame) => frame.id === "expired-phone").error).toBeDefined();
    expect(f.session.pendingApprovals.size).toBe(0);
    expect(f.resolutions()).toHaveLength(1);
    expect(f.resolutions()[0].params).toMatchObject({
      ...routeOf(request),
      approved: false,
      status: "expired",
      failure: "timed_out",
    });
  });

  it("accepts exactly one of two device replies and emits one routed resolution", async () => {
    const f = await fixture();
    const answer = f.ask("Proceed?");
    const route = routeOf(f.request());
    await Promise.all([
      f.approve(route, { approved: true, answer: "yes" }, "desktop"),
      f.approve(route, { approved: true, answer: "no" }, "phone"),
    ]);
    expect(await answer).toBe("yes");
    expect(f.sent.find((frame) => frame.id === "desktop").result).toEqual({ ok: true });
    expect(f.sent.find((frame) => frame.id === "phone").error).toBeDefined();
    expect(f.resolutions()).toHaveLength(1);
    expect(f.resolutions()[0].params).toMatchObject({
      ...route,
      status: "resolved",
      answer: "yes",
    });
  });

  it("retires decisions after connection loss without writing to the disconnected transport", async () => {
    const f = await fixture();
    const answer = f.ask("Proceed?");
    f.server.disconnect("fixture connection lost");
    expect(await answer).toBe("fixture connection lost");
    expect(f.session.pendingApprovals.size).toBe(0);
    expect((f.server as any).approvalTimers.size).toBe(0);
    expect(f.resolutions()).toHaveLength(0);
  });

  it.each(["__future_action__", "__other_future_action__", "__panel_action__"])(
    "keeps reserved host loopback %s internal when it resolves as unsupported",
    async (toolName) => {
      const f = await fixture();
      const decision = (f.server as any).requestApprovalFromClient(
        {
          sessionId: f.sessionId,
          toolName,
          args: {},
          description: "host operation",
          riskLevel: "low",
        },
        { connectionId: "owner", sessionId: f.sessionId, generation: 1 },
      );
      const request = f.request();
      expect(f.session.pendingApprovals.get(request.requestId)!.metadata).toMatchObject({
        kind: "internal",
        surfaceable: false,
      });
      await f.approve(
        routeOf(request),
        {
          approved: true,
          answer: JSON.stringify({ ok: false, failure: "unsupported", capability: toolName }),
        },
        "host-reply",
      );
      expect(await decision).toMatchObject({ approved: true });
      expect(f.session.pendingApprovals.size).toBe(0);
      expect((f.server as any).approvalTimers.size).toBe(0);
      expect((f.server as any).pendingApprovalTargets.size).toBe(0);
      expect(f.resolutions()).toHaveLength(0);
    },
  );

  it("resumes the execution budget once a person has answered", async () => {
    const f = await fixture();
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(
      {
        name: "ConfirmThenStall",
        description: "timeout fixture",
        source: "builtin",
        inputSchema: { type: "object", properties: {} },
      },
      async (_args, ctx) => {
        await ctx!.askUser!("Proceed?");
        return new Promise<never>(() => {});
      },
    );
    const result = registry.executeTool(
      "ConfirmThenStall",
      {},
      { timeoutMs: 25, ctx: { askUser: f.ask } as ToolContext },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    await f.approve(routeOf(f.request()), { approved: true, answer: "yes" }, "desktop");
    expect(await result).toMatchObject({
      isError: true,
      error: "Tool timed out after 25ms: ConfirmThenStall",
    });
    expect(f.session.pendingApprovals.size).toBe(0);
    expect(f.resolutions()).toHaveLength(1);
  });

  it("retires a question when its owning tool finishes without waiting for it", async () => {
    const f = await fixture();
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(
      {
        name: "DetachedQuestion",
        description: "question ownership fixture",
        source: "builtin",
        inputSchema: { type: "object", properties: {} },
      },
      async (_args, ctx) => {
        void ctx!.askUser!("Proceed?").catch(() => {});
        return "finished";
      },
    );
    expect(
      await registry.executeTool(
        "DetachedQuestion",
        {},
        { ctx: { askUser: f.ask } as ToolContext },
      ),
    ).toMatchObject({ isError: false });
    expect(f.session.pendingApprovals.size).toBe(0);
    expect((f.server as any).approvalTimers.size).toBe(0);
    expect((f.server as any).pendingApprovalTargets.size).toBe(0);
    expect(f.resolutions()).toHaveLength(1);
    expect(f.resolutions()[0].params).toMatchObject({ approved: false, status: "cancelled" });
  });

  it("gives an asynchronous question the same deadline and expires it without inventing an answer", async () => {
    const f = await fixture();
    const timers: Array<() => void> = [];
    const setTimeoutOriginal = globalThis.setTimeout;
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: any[]) => void,
      delay?: number,
      ...args: any[]
    ) => {
      if (delay !== undefined && delay >= USER_DECISION_TIMEOUT_MS - 100) {
        timers.push(() => callback(...args));
      }
      return setTimeoutOriginal(callback, delay, ...args);
    }) as typeof setTimeout);
    try {
      const receipt = await (f.server as any).requestAskUserAsyncForSession(
        f.session,
        f.sessionId,
        "Pick later",
      );
      expect(receipt).toContain("No answer has been received");
      const request = f.request();
      expect(f.session.pendingApprovals.get(request.requestId)!.metadata.expiresAt).toBe(
        request.expiresAt,
      );
      expect(timers).toHaveLength(1);
      timers[0]!();
      expect(f.session.pendingApprovals.size).toBe(0);
      expect(f.resolutions()).toHaveLength(1);
      expect(f.resolutions()[0].params).toMatchObject({
        ...routeOf(request),
        status: "expired",
        approved: false,
      });
      await f.approve(routeOf(request), { approved: true, answer: "late" }, "late-phone");
      expect(f.sent.find((frame) => frame.id === "late-phone").error).toBeDefined();
    } finally {
      timerSpy.mockRestore();
    }
  });
});
