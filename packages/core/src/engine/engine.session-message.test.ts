import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { RouteSessionMessageInput } from "../session/session-message.js";
import type { LLMResponse } from "../types.js";
import { Engine } from "./engine.js";
import { createWorkspaceContext } from "../workspace/workspace-context.js";

const provider = "session-message-test";
const callsByModel = new Map<string, number>();
const seenTargetEnums = new Map<string, unknown>();
const dirs: string[] = [];

class SessionMessageClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const call = callsByModel.get(this.model) ?? 0;
    callsByModel.set(this.model, call + 1);
    const definition = options.tools?.find((tool) => tool.name === "SendMessageToSession");
    if (definition) {
      const properties = definition.inputSchema.properties as Record<string, { enum?: unknown }>;
      seenTargetEnums.set(this.model, properties.target_session_id?.enum);
    }
    const response: LLMResponse =
      call === 0
        ? {
            text: "",
            toolCalls: [
              {
                id: "send-ui-work",
                toolName: "SendMessageToSession",
                args: {
                  target_session_id: "ui-session",
                  message: "  Read docs/prd.md and design the UI.  ",
                },
              },
            ],
            stopReason: "tool_use",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }
        : {
            text: "sent",
            toolCalls: [],
            stopReason: "stop",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
    this.recordUsage(response.usage!, options);
    return response;
  }
}

registerProvider(provider, SessionMessageClient);

afterEach(() => {
  callsByModel.clear();
  seenTargetEnums.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Engine SendMessageToSession wiring", () => {
  test("exposes the closed target list and routes the model's message once", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-session-message-"));
    dirs.push(root);
    const model = `session-message-${Date.now()}`;
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: root,
      sessionStorageDir: join(root, "sessions"),
      settingsScope: "isolated",
      permissionMode: "bypassPermissions",
      maxTurns: 3,
    });
    (engine as any).hooks.clear();
    let routed: RouteSessionMessageInput | undefined;
    engine.setSessionMessageRouter(async (input) => {
      routed = input;
    });
    const catalog = [
      { sessionId: "prd-session", title: "Write PRD", workspaceRoot: root },
      {
        sessionId: "ui-session",
        title: "Design UI",
        workspaceRoot: root,
        workspaceProfile: "designer",
      },
    ];

    await engine.run("write the PRD, then ask UI to work", {
      sessionId: "prd-session",
      sessionMessageTargets: catalog,
    });

    expect(seenTargetEnums.get(model)).toEqual(["ui-session"]);
    expect(routed).toEqual({
      sourceSessionId: "prd-session",
      target: catalog[1],
      message: "  Read docs/prd.md and design the UI.  ",
      catalog,
    });
  }, 15_000);

  test("uses project bindings instead of caller-reported workspace roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-session-message-project-"));
    dirs.push(root);
    const sourceRoot = join(root, "source");
    const sameProjectRoot = join(root, "same-project-other-root");
    const foreignRoot = join(root, "foreign");
    mkdirSync(sourceRoot);
    mkdirSync(sameProjectRoot);
    mkdirSync(foreignRoot);
    const model = `session-message-project-${Date.now()}`;
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: sourceRoot,
      sessionStorageDir: join(root, "sessions"),
      settingsScope: "isolated",
      permissionMode: "bypassPermissions",
      maxTurns: 3,
    });
    (engine as any).hooks.clear();
    const manager = engine.getSessionManager();
    const same = manager.create(sameProjectRoot, model, provider, "ui-session");
    manager.saveStateOrUpdateFields(same.state, {
      project: { projectId: "project-1", mainRootId: "same-root" },
    });
    const foreign = manager.create(foreignRoot, model, provider, "foreign-session");
    manager.saveStateOrUpdateFields(foreign.state, {
      project: { projectId: "project-2", mainRootId: "foreign-root" },
    });
    let routed: RouteSessionMessageInput | undefined;
    engine.setSessionMessageRouter(async (input) => {
      routed = input;
    });
    const workspaceContext = createWorkspaceContext({
      projectId: "project-1",
      projectRevision: 1,
      sessionMainRootId: "source-root",
      roots: [{ id: "source-root", path: sourceRoot, role: "primary" }],
    });

    await engine.run("route by binding", {
      sessionId: "source-session",
      cwd: sourceRoot,
      workspaceContext,
      sessionMessageTargets: [
        { sessionId: "ui-session", title: "UI", workspaceRoot: sameProjectRoot },
        { sessionId: "foreign-session", title: "Foreign", workspaceRoot: sourceRoot },
      ],
    });

    expect(seenTargetEnums.get(model)).toEqual(["ui-session"]);
    expect(routed?.target.sessionId).toBe("ui-session");
  }, 15_000);
});
