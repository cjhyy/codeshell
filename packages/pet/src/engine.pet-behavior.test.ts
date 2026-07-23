import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "@cjhyy/code-shell-core/extension";
import { registerProvider } from "@cjhyy/code-shell-core/extension";
import type { CreateMessageOptions } from "@cjhyy/code-shell-core/extension";
import type { LLMResponse, Message } from "@cjhyy/code-shell-core/extension";
import type { ToolDefinition } from "@cjhyy/code-shell-core/extension";
import { Engine } from "@cjhyy/code-shell-core";
import { createPetCapability } from "./capability.js";

const provider = "fake-pet-behavior";
const calls = new Map<
  string,
  Array<{
    tools: string[];
    toolDefinitions: ToolDefinition[];
    systemPrompt: string;
    messages: Message[];
  }>
>();
const tempDirs: string[] = [];

class PetBehaviorClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const modelCalls = calls.get(this.model)!;
    modelCalls.push({
      tools: (options.tools ?? []).map((tool) => tool.name),
      toolDefinitions: structuredClone(options.tools ?? []),
      systemPrompt: options.systemPrompt,
      messages: structuredClone(options.messages),
    });
    const response: LLMResponse =
      modelCalls.length === 1 && this.model.startsWith("gateway-reply-")
        ? {
            text: "",
            toolCalls: [
              {
                id: "gateway-reply",
                toolName: "GatewayReply",
                args: {
                  text: "工具回复",
                  button: { text: "打开", url: "https://example.test/result" },
                },
              },
            ],
            stopReason: "tool_use",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }
        : modelCalls.length === 1
          ? {
              text: "",
              toolCalls: [
                {
                  id: "forbidden-write",
                  toolName: "Write",
                  args: { file_path: "should-not-exist.txt", content: "blocked" },
                },
                {
                  id: "delegate-work",
                  toolName: "DelegateWork",
                  args: {
                    workspace_id: "workspace-codeshell",
                    session_id: "session-existing",
                    objective: "inspect CodeShell",
                  },
                },
              ],
              stopReason: "tool_use",
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            }
          : {
              text: "safe answer",
              toolCalls: [],
              stopReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            };
    this.recordUsage(response.usage!, options);
    return response;
  }
}

registerProvider(provider, PetBehaviorClient);

afterEach(() => {
  calls.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Engine pet behavior", () => {
  test("persists manager identity and exposes only structured work delegation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-pet-"));
    tempDirs.push(cwd);
    const model = `pet-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      extensionModules: [createPetCapability()],
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 3,
    });
    (engine as any).hooks.clear();

    const result = await engine.run("global status", {
      sessionId: "local-pet",
      kind: "pet",
      behaviorMode: "pet",
      permissionMode: "bypassPermissions",
      petRuntimeContext: '{"pending":[{"title":"runtime-only-hunter2"}]}',
      petWorkspaces: [
        { id: "workspace-codeshell", name: "CodeShell", description: "/work/codeshell" },
      ],
      profileParams: {
        reusableSessions: [
          {
            id: "session-existing",
            workspaceId: "workspace-codeshell",
            name: "Existing work",
          },
        ],
        sessionsRootDir: join(cwd, "sessions"),
      },
    });

    const first = calls.get(model)![0]!;
    expect(first.systemPrompt).toContain("# Local Mimi Manager Boundary");
    expect(first.systemPrompt).not.toContain("<!--PET:AUTO_DELEGATE-->");
    expect(first.systemPrompt).toContain("decide automatically");
    expect(first.systemPrompt).toContain("complaints, or corrections about Mimi's own routing");
    expect(first.systemPrompt).toContain("runtime-only-hunter2");
    expect(JSON.stringify(first.messages)).not.toContain("runtime-only-hunter2");
    expect(first.tools).toEqual(["DelegateWork", "Sessions"]);
    expect(result.petWorkDelegation).toEqual({
      workspaceId: "workspace-codeshell",
      objective: "inspect CodeShell",
      reusableSessionId: "session-existing",
    });
    expect(result.extensions).toEqual({
      pet: {
        workDelegation: {
          workspaceId: "workspace-codeshell",
          objective: "inspect CodeShell",
          reusableSessionId: "session-existing",
        },
      },
    });
    expect(existsSync(join(cwd, "should-not-exist.txt"))).toBe(false);
    expect(JSON.stringify(calls.get(model)![1]!.messages)).toContain(
      "not allowed by this run profile",
    );
    expect(engine.getSessionManager().readSessionKind("local-pet")).toBe("pet");
    const transcript = readFileSync(join(cwd, "sessions", "local-pet", "transcript.jsonl"), "utf8");
    expect(transcript).not.toContain("runtime-only-hunter2");
  });

  test("restored pet identity keeps the safe profile and rejects kind rewrites", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-pet-resume-"));
    tempDirs.push(cwd);
    const model = `pet-resume-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      extensionModules: [createPetCapability()],
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 3,
    });
    (engine as any).hooks.clear();
    await engine.run("first", { sessionId: "pet", kind: "pet" });

    calls.set(model, []);
    await engine.run("second", { sessionId: "pet" });
    expect(calls.get(model)![0]!.tools).not.toContain("Write");
    // No host-provided sessionsRootDir on this turn, so the Sessions tool must
    // stay invisible instead of surfacing as a permanently-broken tool.
    expect(calls.get(model)![0]!.tools).not.toContain("Sessions");

    await expect(engine.run("rewrite", { sessionId: "pet", kind: "work" })).rejects.toThrow(
      "session kind mismatch",
    );
  });

  test("exposes Gateway discovery before the per-route GatewayReply execution tool", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-pet-gateway-reply-"));
    tempDirs.push(cwd);
    const model = `gateway-reply-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      extensionModules: [createPetCapability()],
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 3,
    });
    (engine as any).hooks.clear();

    const result = await engine.run("请通过 Gateway 回复", {
      sessionId: "gateway-pet",
      kind: "pet",
      behaviorMode: "pet",
      profileParams: {
        gateway: {
          currentChannel: "line",
          channels: [
            {
              channel: "line",
              capabilities: {
                inbound: {
                  text: true,
                  attachments: ["image", "file", "audio", "video"],
                },
                outbound: {
                  text: true,
                  maxTextLength: 8_000,
                  button: "native",
                  attachments: [],
                },
              },
            },
          ],
        },
        hostActions: ["gatewayReply"],
        gatewayReply: {
          button: "link",
          attachments: [],
          maxTextLength: 8_000,
          maxAttachments: 4,
          maxAttachmentBytes: 10 * 1024 * 1024,
        },
        sessionsRootDir: join(cwd, "sessions"),
      },
    });

    const first = calls.get(model)![0]!;
    expect(first.tools).toEqual(["Gateway", "GatewayReply", "Sessions"]);
    expect(first.toolDefinitions[0]?.inputSchema.properties.action).toMatchObject({
      enum: ["search", "describe"],
    });
    expect(first.toolDefinitions[1]?.inputSchema.properties).not.toHaveProperty("attachment_paths");
    expect(result.extensions?.pet).toEqual({
      hostActions: [
        {
          kind: "gatewayReply",
          payload: {
            text: "工具回复",
            button: { text: "打开", url: "https://example.test/result" },
          },
        },
      ],
    });
  });
});
