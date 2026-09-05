import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";
import type { ToolContext } from "../tool-system/context.js";
import { Engine } from "./engine.js";

const provider = "fake-profile-input-change";
const scenarios = new Map<string, { calls: number }>();

class InputChangeClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model)!;
    const response: LLMResponse = {
      text: "corrected answer",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    if (options.tools?.some((tool) => tool.name === "CommitDraft")) {
      scenario.calls++;
      if (scenario.calls === 1) {
        response.text = "";
        response.toolCalls = [{ id: "draft", toolName: "CommitDraft", args: {} }];
        response.stopReason = "tool_use";
      }
    }
    this.recordUsage(response.usage!, options);
    return response;
  }
}

registerProvider(provider, InputChangeClient);

describe("Engine behavior-profile user input lifecycle", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    scenarios.clear();
  });

  function setup(revoke: boolean) {
    const root = mkdtempSync(join(tmpdir(), "profile-input-change-"));
    roots.push(root);
    const model = `${provider}-${root}`;
    const scenario = { calls: 0 };
    scenarios.set(model, scenario);
    const events: StreamEvent[] = [];
    const order: string[] = [];
    const servicesSeen: Record<string, unknown>[] = [];
    let serviceInstance: Record<string, unknown> | undefined;
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: root,
      sessionStorageDir: join(root, "sessions"),
      settingsScope: "isolated",
      enabledBuiltinTools: [],
      maxTurns: 4,
      headless: true,
      permissionMode: "bypassPermissions",
      behaviorProfiles: [
        {
          id: "drafting-profile",
          allowedToolNames: new Set(["CommitDraft"]),
          disableMcp: true,
          disableHooks: true,
          disableInstructions: true,
          disableMemoryContext: true,
          disableSessionTitle: true,
          createRunServices: ({ reportResult }) => {
            let actions: string[] = [];
            serviceInstance = {
              commit() {
                actions = ["pending draft", "accepted independent action"];
                reportResult("actions", [...actions]);
              },
              invalidateDraft() {
                actions = actions.filter((action) => action !== "pending draft");
                reportResult("actions", [...actions]);
              },
            };
            return serviceInstance;
          },
          onUserInputChanged: (services) => {
            servicesSeen.push(services);
            order.push("changed");
            (services.invalidateDraft as () => void)();
          },
        },
      ],
    });
    (engine as any).hooks.clear();
    engine.registerCustomTool(
      {
        name: "CommitDraft",
        description: "Record a deferred response and an independent action",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
        permissionDefault: "allow",
      },
      async (_args, ctx?: ToolContext) => {
        expect(servicesSeen).toHaveLength(0);
        (ctx!.runScopedServices!.commit as () => void)();
        ctx!.runYield!.request("reply_committed");
        expect(
          engine.enqueueSteer("s-input-change", "first correction", "steer-1", "client-1").accepted,
        ).toBe(true);
        expect(
          engine.enqueueSteer("s-input-change", "second correction", "steer-2", "client-2")
            .accepted,
        ).toBe(true);
        // Merely accepting input into the queue must not invalidate a reply.
        expect(servicesSeen).toHaveLength(0);
        order.push("enqueued");
        if (revoke) {
          expect(engine.unsteer("s-input-change", "steer-1")).toBe(true);
          expect(engine.unsteer("s-input-change", "steer-2")).toBe(true);
        }
        return "draft recorded";
      },
    );
    return {
      root,
      scenario,
      servicesSeen,
      order,
      get serviceInstance() {
        return serviceInstance;
      },
      run: () =>
        engine.run("original user request", {
          sessionId: "s-input-change",
          clientMessageId: "client-submit",
          behaviorMode: "drafting-profile",
          onStream: (event) => {
            events.push(event);
            if (event.type === "steer_injected") order.push("injected");
          },
        }),
    };
  }

  test("notifies the active profile for each consumed steer before publishing injection", async () => {
    const harness = setup(false);
    const result = await harness.run();
    expect(result.reason).toBe("completed");
    expect(result.text).toBe("corrected answer");
    expect(harness.scenario.calls).toBe(2);
    expect(harness.servicesSeen).toEqual([harness.serviceInstance, harness.serviceInstance]);
    expect(harness.order).toEqual(["enqueued", "changed", "injected", "changed", "injected"]);
    expect(result.extensions?.["drafting-profile"]).toEqual({
      actions: ["accepted independent action"],
    });
    const transcript = readFileSync(
      join(harness.root, "sessions/s-input-change/transcript.jsonl"),
      "utf8",
    );
    expect(transcript).toContain("first correction");
    expect(transcript).toContain("second correction");
  });

  test("does not notify for initial input or steers revoked before injection", async () => {
    const harness = setup(true);
    const result = await harness.run();
    expect(result.reason).toBe("completed");
    expect(harness.scenario.calls).toBe(1);
    expect(harness.servicesSeen).toHaveLength(0);
    expect(harness.order).toEqual(["enqueued"]);
    expect(result.extensions?.["drafting-profile"]).toEqual({
      actions: ["pending draft", "accepted independent action"],
    });
  });
});
