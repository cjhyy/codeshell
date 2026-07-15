/**
 * Identity dimension foundations (Task 2): AgentServer resolveIdentity hook.
 *
 * Two in-process servers share ONE base ChatSessionManager but resolve to
 * different identities. The same sessionId must route to two isolated
 * per-identity sessions (with per-identity persistence roots), a connection's
 * session list must only contain its own identity's sessions, and identity B
 * must NOT be able to fetch a session that is live only under identity A
 * (SessionNotFound). Without the hook the server must keep using the base
 * manager exactly as today.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentServer } from "./server.js";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";
import { ErrorCodes } from "./types.js";
import { ApprovalRouter } from "../tool-system/permission.js";
import type { Engine, EngineResult } from "../engine/engine.js";

function makeTransport() {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (m: unknown) => sent.push(m),
      onMessage: (cb: (msg: unknown) => void) => {
        onMsg = cb;
      },
      close: () => {},
    } as any,
  };
}

function makeFakeEngine(slice: EngineConfigSlice, runs: EngineConfigSlice[]) {
  return {
    setAskUser() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    isHeadless: () => false,
    sessionExistsOnDisk: () => false,
    async run(): Promise<EngineResult> {
      runs.push(slice);
      return {
        text: "ok",
        reason: "completed",
        sessionId: "x",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
}

function lastError(sent: any[]): { code?: number; message?: string } | undefined {
  const errs = sent.filter((m) => m && m.error);
  return errs.length ? errs[errs.length - 1].error : undefined;
}

function response(sent: any[], id: number): any {
  return sent.find((m) => m && m.id === id && (m.result || m.error));
}

async function settle(ms = 15) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("AgentServer resolveIdentity routing", () => {
  it("routes the same sessionId to two isolated identity-scoped sessions", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "csh-server-identity-"));
    try {
      const factorySlices: EngineConfigSlice[] = [];
      const runSlices: EngineConfigSlice[] = [];
      const base = new ChatSessionManager({
        runtime: {} as never,
        engineFactory: (slice) => {
          factorySlices.push(slice);
          return makeFakeEngine(slice, runSlices);
        },
        dataRoot,
      });

      const tA = makeTransport();
      new AgentServer({
        transport: tA.transport,
        chatManager: base,
        connectionId: "conn-a",
        approvalRouter: new ApprovalRouter(),
        resolveIdentity: ({ connectionId }) => (connectionId === "conn-a" ? "user-a" : "user-b"),
      });
      const tB = makeTransport();
      new AgentServer({
        transport: tB.transport,
        chatManager: base,
        connectionId: "conn-b",
        approvalRouter: new ApprovalRouter(),
        resolveIdentity: ({ connectionId }) => (connectionId === "conn-a" ? "user-a" : "user-b"),
      });

      tA.deliver({
        jsonrpc: "2.0",
        id: 1,
        method: "agent/run",
        params: { sessionId: "shared-sid", task: "hi from a" },
      });
      tB.deliver({
        jsonrpc: "2.0",
        id: 1,
        method: "agent/run",
        params: { sessionId: "shared-sid", task: "hi from b" },
      });
      await settle();

      // Both runs completed — the shared sessionId did NOT collide.
      expect(lastError(tA.sent)).toBeUndefined();
      expect(lastError(tB.sent)).toBeUndefined();
      expect(runSlices).toHaveLength(2);

      // Each identity's engine was built with its own persistence root.
      const roots = factorySlices.map((s) => s.sessionStorageDir).sort();
      expect(roots).toEqual([
        join(dataRoot, "identities", "user-a", "sessions"),
        join(dataRoot, "identities", "user-b", "sessions"),
      ]);

      // The base ("local") manager never hosted the session.
      expect(base.get("shared-sid")).toBeUndefined();
      expect(base.sessionCount()).toBe(0);

      // Session lists are scoped to the connection's identity: each server
      // sees exactly one "shared-sid" session — its own.
      tA.deliver({ jsonrpc: "2.0", id: 2, method: "agent/query", params: { type: "sessions" } });
      tB.deliver({ jsonrpc: "2.0", id: 2, method: "agent/query", params: { type: "sessions" } });
      await settle();
      const listA = response(tA.sent, 2)?.result?.data as Array<{ sessionId: string }>;
      const listB = response(tB.sent, 2)?.result?.data as Array<{ sessionId: string }>;
      expect(listA.map((s) => s.sessionId)).toEqual(["shared-sid"]);
      expect(listB.map((s) => s.sessionId)).toEqual(["shared-sid"]);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("identity B cannot fetch a session live only under identity A (SessionNotFound)", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "csh-server-identity-nf-"));
    try {
      const runSlices: EngineConfigSlice[] = [];
      const base = new ChatSessionManager({
        runtime: {} as never,
        engineFactory: (slice) => makeFakeEngine(slice, runSlices),
        dataRoot,
      });
      const resolveIdentity = ({ connectionId }: { connectionId: string }) =>
        connectionId === "conn-a" ? "user-a" : "user-b";

      const tA = makeTransport();
      new AgentServer({
        transport: tA.transport,
        chatManager: base,
        connectionId: "conn-a",
        approvalRouter: new ApprovalRouter(),
        resolveIdentity,
      });
      const tB = makeTransport();
      new AgentServer({
        transport: tB.transport,
        chatManager: base,
        connectionId: "conn-b",
        approvalRouter: new ApprovalRouter(),
        resolveIdentity,
      });

      // Create the session under identity A only.
      tA.deliver({
        jsonrpc: "2.0",
        id: 1,
        method: "agent/run",
        params: { sessionId: "only-a-sid", task: "hello" },
      });
      await settle();
      expect(lastError(tA.sent)).toBeUndefined();

      // Identity A can address its live session (requireExisting hits the
      // live map, no disk probe needed).
      tA.deliver({
        jsonrpc: "2.0",
        id: 2,
        method: "agent/run",
        params: { sessionId: "only-a-sid", task: "again", requireExisting: true },
      });
      await settle();
      expect(lastError(tA.sent)).toBeUndefined();
      expect(runSlices).toHaveLength(2);

      // Identity B addressing the same sid fails with SessionNotFound and
      // never runs an engine turn.
      tB.deliver({
        jsonrpc: "2.0",
        id: 3,
        method: "agent/run",
        params: { sessionId: "only-a-sid", task: "steal", requireExisting: true },
      });
      await settle();
      expect(response(tB.sent, 3)?.error?.code).toBe(ErrorCodes.SessionNotFound);
      expect(runSlices).toHaveLength(2);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("without resolveIdentity the base manager is used unchanged", async () => {
    const runSlices: EngineConfigSlice[] = [];
    const factorySlices: EngineConfigSlice[] = [];
    const base = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: (slice) => {
        factorySlices.push(slice);
        return makeFakeEngine(slice, runSlices);
      },
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager: base });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params: { sessionId: "plain-sid", task: "hello" },
    });
    await settle();

    expect(lastError(t.sent)).toBeUndefined();
    expect(base.get("plain-sid")).toBeDefined();
    expect(factorySlices[0]!.sessionStorageDir).toBeUndefined();
    expect(base.getLiveSessionSnapshot().identity).toBe("local");
  });
});
