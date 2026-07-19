import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { RouteSessionMessageInput } from "../session/session-message.js";
import type { LLMResponse } from "../types.js";
import { Engine } from "./engine.js";

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
});
