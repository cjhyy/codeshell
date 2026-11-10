import { createFakeEngine } from "../testing/create-fake-engine.js";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookRegistry } from "../hooks/registry.js";
import { ApprovalRouter, type ApprovalRequest } from "../tool-system/permission.js";
import type { ApprovalResult } from "../types.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { Methods } from "./types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "decision-hooks-"));
  const hooks = new HookRegistry();
  const seen: Array<Record<string, unknown>> = [];
  hooks.register("notification", (ctx) => {
    seen.push(ctx.data);
    return {};
  });
  const manager = new ChatSessionManager({
    runtime: {} as never,
    dataRoot: cwd,
    engineFactory: () =>
      createFakeEngine({
        dispose() {},
        isHeadless: () => false,
        getHookRegistry: () => hooks,
      }),
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
  const lastRequest = () =>
    sent.filter((frame) => frame.method === Methods.ApprovalRequest).at(-1)!.params;
  const route = () => router.current(sessionId)!;
  return {
    hooks,
    seen,
    session,
    sessionId,
    server,
    approvalFor: (toolName: string) =>
      (server as any).requestApprovalFromClient(
        {
          toolName,
          sessionId,
          args: { command: "rm -rf build" },
          description: "rm -rf build",
          riskLevel: "high",
        } satisfies ApprovalRequest,
        route(),
      ) as Promise<ApprovalResult>,
    ask: (question: string, header?: string) =>
      (server as any).requestAskUserForSession(session, sessionId, question, {
        ...(header ? { header } : {}),
      }) as Promise<string>,
    decide: async (decision: unknown) => {
      const request = lastRequest();
      await (server as any).handleApprove({
        jsonrpc: "2.0",
        id: `approve-${request.requestId}`,
        params: {
          connectionId: request.connectionId,
          sessionId: request.sessionId,
          generation: request.generation,
          requestId: request.requestId,
          decision,
        },
      });
      return request.requestId as string;
    },
  };
}

describe("notification hooks for user decisions", () => {
  it("announces a tool approval when it is raised and when it is answered", async () => {
    const f = await fixture();
    const approval = f.approvalFor("Bash");
    await settle();
    expect(f.seen).toEqual([
      {
        kind: "approval_requested",
        sessionId: f.sessionId,
        requestId: expect.any(String),
        toolName: "Bash",
        riskLevel: "high",
        message: "等待批准 Bash",
      },
    ]);
    const requestId = await f.decide({ approved: true });
    expect(await approval).toMatchObject({ approved: true });
    await settle();
    expect(f.seen[1]).toEqual({
      kind: "approval_resolved",
      sessionId: f.sessionId,
      requestId,
      toolName: "Bash",
      riskLevel: "high",
      message: "等待批准 Bash",
      decision: "approved",
      approved: true,
    });
    expect(f.seen[0]!.requestId).toBe(requestId);
  });

  it("reports a denial as denied", async () => {
    const f = await fixture();
    const approval = f.approvalFor("Write");
    await f.decide({ approved: false, reason: "no" });
    await approval;
    await settle();
    expect(f.seen.map((data) => [data.kind, data.decision])).toEqual([
      ["approval_requested", undefined],
      ["approval_resolved", "denied"],
    ]);
  });

  it("announces a question with its title and the user's answer outcome", async () => {
    const f = await fixture();
    const answer = f.ask("Which color should the button be?", "Button color");
    await settle();
    expect(f.seen[0]).toEqual({
      kind: "ask_user_requested",
      sessionId: f.sessionId,
      requestId: expect.any(String),
      title: "Button color",
      question: "Which color should the button be?",
      message: "Button color",
    });
    await f.decide({ approved: true, answer: "blue" });
    expect(await answer).toBe("blue");
    await settle();
    expect(f.seen[1]).toMatchObject({
      kind: "ask_user_resolved",
      requestId: f.seen[0]!.requestId,
      decision: "answered",
      approved: true,
    });
    // The answer itself never rides the hook payload.
    expect(JSON.stringify(f.seen[1])).not.toContain("blue");
  });

  it("never announces internal host loopbacks", async () => {
    const f = await fixture();
    for (const toolName of ["__workspace_action__", "__host_action__", "__panel_action__"]) {
      const pending = f.approvalFor(toolName);
      await f.decide({ approved: true, answer: "{}" });
      await pending;
    }
    await settle();
    expect(f.seen).toEqual([]);
  });

  it("a failing or slow hook never affects the decision", async () => {
    const f = await fixture();
    f.hooks.register("notification", () => {
      throw new Error("hook exploded");
    });
    f.hooks.register("notification", () => new Promise<never>(() => undefined));
    const approval = f.approvalFor("Bash");
    await f.decide({ approved: true });
    expect(await approval).toMatchObject({ approved: true });
  });

  it("a cancelled question is announced as cancelled", async () => {
    const f = await fixture();
    const answer = f.ask("Proceed?");
    await settle();
    const requestId = f.seen[0]!.requestId as string;
    (f.server as any).finishSessionUserDecision(
      f.session,
      requestId,
      { approved: false, failure: "cancelled", reason: "stopped" },
      "cancelled",
    );
    await answer;
    await settle();
    expect(f.seen[1]).toMatchObject({
      kind: "ask_user_resolved",
      requestId,
      decision: "cancelled",
      approved: false,
      message: "Proceed?",
    });
  });
});
