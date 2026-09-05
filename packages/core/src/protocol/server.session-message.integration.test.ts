import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../engine/engine.js";
import { registerProvider } from "../llm/client-factory.js";
import { LLMClientBase } from "../llm/client-base.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type {
  RouteSessionMessageInput,
  SessionMessageReceipt,
} from "../session/session-message.js";
import { NotificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { defaultSandboxConfig } from "../tool-system/sandbox/index.js";
import type { LLMResponse, SessionState } from "../types.js";
import { createWorkspaceContext } from "../workspace/workspace-context.js";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";

const provider = "fake-session-message-integration";
const requests = new Map<string, CreateMessageOptions[]>();
const responseGates = new Map<string, Promise<void>>();

class SessionMessageClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const calls = requests.get(this.model);
    if (!calls) throw new Error(`Unexpected test model: ${this.model}`);
    calls.push(options);
    await responseGates.get(this.model);
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return {
      text: "The existing records have been read. No external data was changed.",
      toolCalls: [],
      stopReason: "stop",
      usage,
    };
  }
}

registerProvider(provider, SessionMessageClient);

// Production closeAll also reaps process-wide background shells and removes
// global agent output files. This fixture only owns its two temporary sessions.
class IsolatedSessionManager extends ChatSessionManager {
  override closeAll(): void {
    this.forEachSession((session) => void this.close(session.id));
  }
}

interface RoutingServer {
  rememberSessionSlice(sessionId: string, slice: EngineConfigSlice): void;
  routeSessionMessage(input: RouteSessionMessageInput): Promise<SessionMessageReceipt>;
}

async function fixture(authoritativeContext = true, holdResponse = false) {
  const dir = mkdtempSync(join(tmpdir(), "session-message-integration-"));
  const root = join(dir, "project");
  const sessionsDir = join(dir, "sessions");
  mkdirSync(root);
  const model = `session-message-${Date.now()}-${Math.random()}`;
  const calls: CreateMessageOptions[] = [];
  requests.set(model, calls);
  let releaseResponse = () => {};
  if (holdResponse) {
    responseGates.set(
      model,
      new Promise<void>((resolve) => {
        releaseResponse = resolve;
      }),
    );
  }
  const context = createWorkspaceContext({
    projectId: "message-project",
    projectRevision: 3,
    sessionMainRootId: "message-root",
    roots: [{ id: "message-root", path: root, role: "primary" }],
  });
  const slices: EngineConfigSlice[] = [];
  const manager = new IsolatedSessionManager({
    runtime: {} as never,
    engineFactory(slice) {
      slices.push(slice);
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        ...slice,
        cwd: slice.cwd ?? root,
        sessionStorageDir: sessionsDir,
        settingsScope: "isolated",
        enabledBuiltinTools: [],
        headless: true,
        permissionMode: "bypassPermissions",
        sandbox: defaultSandboxConfig("off"),
        maxTurns: 1,
      });
      (engine as unknown as { hooks: { clear(): void } }).hooks.clear();
      return engine;
    },
  });
  const sourceSlice = {
    cwd: root,
    projectTrusted: true,
    ...(authoritativeContext ? { workspaceContext: context } : {}),
  } satisfies EngineConfigSlice;
  const source = await manager.getOrCreate("source", sourceSlice);
  const storage = source.engine.getSessionManager();
  for (const sessionId of ["source", "target"]) {
    storage.create(root, model, provider, sessionId);
    storage.updateSessionState(sessionId, {
      project: { projectId: context.projectId, mainRootId: context.sessionMainRootId },
      title: sessionId,
    });
  }
  const sent: unknown[] = [];
  const mailbox = new NotificationQueue();
  const server = new AgentServer({
    chatManager: manager,
    sessionDiskRoot: sessionsDir,
    notificationMailbox: mailbox,
    ownsBackgroundWakeups: false,
    transport: {
      send(message: unknown) {
        sent.push(message);
      },
      onMessage() {},
      close() {},
    } as never,
  });
  const routing = server as unknown as RoutingServer;
  routing.rememberSessionSlice("source", sourceSlice);
  const catalog = [
    { sessionId: "source", title: "Source", workspaceRoot: root },
    { sessionId: "target", title: "Target", workspaceRoot: root },
  ];
  const input: RouteSessionMessageInput = {
    sourceSessionId: "source",
    target: catalog[1]!,
    message: "Report only the records you have already read. Do not change external data.",
    catalog,
  };

  return {
    calls,
    context,
    input,
    mailbox,
    manager,
    releaseResponse,
    routing,
    sent,
    slices,
    readTranscript: (sessionId: string) =>
      readFileSync(join(sessionsDir, sessionId, "transcript.jsonl"), "utf8"),
    readState: (sessionId: string) =>
      JSON.parse(readFileSync(join(sessionsDir, sessionId, "state.json"), "utf8")) as SessionState,
    async close() {
      releaseResponse();
      await Promise.all([manager.close("source"), manager.close("target")]);
      server.close();
      requests.delete(model);
      responseGates.delete(model);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("AgentServer cross-Session messaging with a real Engine", () => {
  test("cold-starts a project-bound target with its authoritative workspace and persists the turn", async () => {
    const f = await fixture();
    try {
      expect(f.manager.get("target")).toBeUndefined();

      const receipt = await f.routing.routeSessionMessage(f.input);
      await f.manager.get("target")?.settled;

      expect(receipt.messageId.length).toBeGreaterThan(0);
      expect(["queued", "started", "completed"]).toContain(receipt.status);
      expect(f.calls.length).toBeGreaterThan(0);
      expect(f.slices.at(-1)?.workspaceContext).toEqual(f.context);
      expect(f.readState("target")).toMatchObject({
        project: { projectId: "message-project", mainRootId: "message-root" },
        status: "completed",
        turnCount: 1,
      });
      expect(f.readTranscript("target")).toContain(f.input.message);
      expect(f.readTranscript("target")).toContain("The existing records have been read.");
      expect(f.manager.get("target")?.isBusy()).toBe(false);
    } finally {
      await f.close();
    }
  });

  test("rejects a bound target with no authoritative workspace instead of claiming delivery", async () => {
    const f = await fixture(false);
    try {
      const before = f.readTranscript("target");

      await expect(f.routing.routeSessionMessage(f.input)).rejects.toThrow(
        /WorkspaceContext|workspace/i,
      );
      await f.manager.get("target")?.settled;

      expect(f.calls).toEqual([]);
      expect(f.readTranscript("target")).toBe(before);
      expect(f.readState("target").turnCount).toBe(0);
      expect(f.manager.get("target")?.isBusy() ?? false).toBe(false);
    } finally {
      await f.close();
    }
  });

  test("returns a delayed real target reply to the source mailbox with its dispatch id", async () => {
    const f = await fixture(true, true);
    try {
      const receipt = await f.routing.routeSessionMessage(f.input);
      expect(["queued", "started"]).toContain(receipt.status);
      expect(f.manager.get("target")?.isBusy()).toBe(true);
      expect(f.mailbox.getSnapshot("source")).toEqual([]);

      f.releaseResponse();
      await f.manager.get("target")?.settled;

      expect(f.mailbox.getSnapshot("source")).toHaveLength(1);
      expect(f.mailbox.getSnapshot("source")[0]).toMatchObject({
        kind: "result",
        from: { sessionId: "target" },
        to: { sessionId: "source" },
        correlationId: receipt.messageId,
        payload: {
          workId: receipt.messageId,
          status: "completed",
          finalText: "The existing records have been read. No external data was changed.",
        },
      });
      expect(f.mailbox.getSnapshot("target")).toEqual([]);
      expect(f.readState("source").turnCount).toBe(0);
    } finally {
      await f.close();
    }
  });
});
