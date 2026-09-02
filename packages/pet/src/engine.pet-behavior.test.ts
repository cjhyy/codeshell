import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "@cjhyy/code-shell-core/extension";
import { registerProvider } from "@cjhyy/code-shell-core/extension";
import type { CreateMessageOptions } from "@cjhyy/code-shell-core/extension";
import type { LLMResponse, Message, StreamEvent } from "@cjhyy/code-shell-core/extension";
import type { ToolDefinition } from "@cjhyy/code-shell-core/extension";
import { Engine } from "@cjhyy/code-shell-core";
import { createPetModule } from "./capability.js";

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
    const gatewayReplyRound = modelCalls.filter((call) =>
      call.tools.includes("GatewayReply"),
    ).length;
    const response: LLMResponse = this.model.startsWith("gateway-reply-batch-")
      ? {
          text: "",
          toolCalls: [
            {
              id: "gateway-reply",
              toolName: "GatewayReply",
              args: { text: "工具回复" },
            },
            {
              id: "duplicate-gateway-reply",
              toolName: "GatewayReply",
              args: { text: "重复回复" },
            },
          ],
          stopReason: "tool_use",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }
      : this.model.startsWith("gateway-reply-runaway-")
        ? !modelCalls.at(-1)!.tools.includes("GatewayReply")
          ? {
              text: "session title",
              toolCalls: [],
              stopReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            }
          : gatewayReplyRound === 1
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
            : gatewayReplyRound === 2
              ? {
                  text: "stray assistant text after the accepted reply",
                  toolCalls: [
                    {
                      id: "duplicate-gateway-reply",
                      toolName: "GatewayReply",
                      args: { text: "duplicate reply" },
                    },
                  ],
                  stopReason: "tool_use",
                  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                }
              : {
                  text: "more stray assistant text",
                  toolCalls: [],
                  stopReason: "stop",
                  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                }
        : modelCalls.length === 1 && this.model.startsWith("gateway-reply-")
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
    // Pet's tool allowlist has no Skill tool, so installed skills must never
    // ride the dynamic-context message of a Mimi turn.
    const skillDir = join(cwd, ".code-shell", "skills", "pet-invisible-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: pet-invisible-skill\ndescription: must not appear in pet context\n---\nbody",
    );
    const model = `pet-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      modules: [createPetModule()],
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
    expect(first.systemPrompt).toContain("owner-authored personalization");
    expect(first.systemPrompt).toContain("never override Mimi's manager boundary");
    expect(first.systemPrompt).not.toContain("<!--PET:AUTO_DELEGATE-->");
    expect(first.systemPrompt).toContain("decide automatically");
    expect(first.systemPrompt).toContain("complaints, or corrections about Mimi's own routing");
    expect(first.systemPrompt).toContain("runtime-only-hunter2");
    expect(JSON.stringify(first.messages)).not.toContain("runtime-only-hunter2");
    expect(JSON.stringify(first.messages)).not.toContain("Goal 工具状态");
    expect(JSON.stringify(first.messages)).not.toContain("pet-invisible-skill");
    expect(JSON.stringify(first.messages)).not.toContain("active goal");
    expect(first.tools).toEqual(["DelegateWork", "Sessions", "FollowUps", "CurrentTime"]);
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
      modules: [createPetModule()],
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
      modules: [createPetModule()],
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 3,
    });
    (engine as any).hooks.clear();
    const events: StreamEvent[] = [];

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
      onStream: (event) => events.push(event),
    });

    const first = calls.get(model)![0]!;
    expect(first.tools).toEqual([
      "Gateway",
      "GatewayReply",
      "Sessions",
      "FollowUps",
      "CurrentTime",
    ]);
    expect(first.toolDefinitions[0]?.inputSchema.properties.action).toMatchObject({
      enum: ["search", "describe"],
    });
    expect(first.toolDefinitions[1]?.inputSchema.properties).not.toHaveProperty("attachment_paths");
    expect(events.filter((event) => event.type === "stream_request_start")).toHaveLength(1);
    expect(result.reason).toBe("completed");
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

  test("stops after the first accepted GatewayReply even when the model would continue", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-pet-gateway-reply-stop-"));
    tempDirs.push(cwd);
    const model = `gateway-reply-runaway-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
    const events: StreamEvent[] = [];
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      modules: [createPetModule()],
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 4,
    });
    (engine as any).hooks.clear();

    const result = await engine.run("请通过 Gateway 回复", {
      sessionId: "gateway-pet-runaway",
      kind: "pet",
      behaviorMode: "pet",
      onStream: (event) => events.push(event),
      profileParams: {
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

    expect(events.filter((event) => event.type === "stream_request_start")).toHaveLength(1);
    expect(calls.get(model)!.filter((call) => call.tools.includes("GatewayReply"))).toHaveLength(1);
    expect(result.reason).toBe("completed");
    expect(result.text).toBe("");
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
    expect(events.find((event) => event.type === "turn_complete")).toEqual({
      type: "turn_complete",
      reason: "completed",
    });
  });

  test("skips duplicate GatewayReply calls left in the same model batch", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-pet-gateway-reply-batch-"));
    tempDirs.push(cwd);
    const model = `gateway-reply-batch-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
    const events: StreamEvent[] = [];
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      modules: [createPetModule()],
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 4,
    });
    (engine as any).hooks.clear();

    const result = await engine.run("请通过 Gateway 回复", {
      sessionId: "gateway-pet-batch",
      kind: "pet",
      behaviorMode: "pet",
      onStream: (event) => events.push(event),
      profileParams: {
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

    const toolResults = events
      .filter(
        (event): event is Extract<StreamEvent, { type: "tool_result" }> =>
          event.type === "tool_result",
      )
      .map((event) => event.result);
    expect(events.filter((event) => event.type === "stream_request_start")).toHaveLength(1);
    expect(result.reason).toBe("completed");
    expect(result.extensions?.pet).toEqual({
      hostActions: [{ kind: "gatewayReply", payload: { text: "工具回复" } }],
    });
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toMatchObject({ id: "gateway-reply", isError: false });
    expect(toolResults[1]).toMatchObject({
      id: "duplicate-gateway-reply",
      isError: true,
      error: expect.stringContaining("authoritative host reply was already committed"),
    });
  });
});
