import { initialToolsFixtureModule } from "./initial-tools-preset.fixture.js";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";
import type { ToolContext } from "../tool-system/context.js";
import { bashTool, bashToolDef } from "../tool-system/builtin/bash.js";
import {
  bashOutputTool,
  bashOutputToolDef,
} from "../tool-system/builtin/background-shell-tools.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { BackgroundShellManager } from "../runtime/background-shell.js";
import { Engine } from "./engine.js";

let providerSequence = 0;

function harness(behavior?: "continue" | "wait_for_exit") {
  const directory = mkdtempSync(join(tmpdir(), "bash-background-continuation-"));
  const previousHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = directory;
  notificationQueue.reset();
  const manager = new BackgroundShellManager();
  const provider = `bash-background-continuation-${++providerSequence}`;
  const events: StreamEvent[] = [];
  let mainRequests = 0;
  let inspectedWhileRunning = false;

  class Provider extends LLMClientBase {
    protected initClient(): void {}

    async createMessage(request: CreateMessageOptions): Promise<LLMResponse> {
      const usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
      this.recordUsage(usage, request);
      if (!request.tools?.some((tool) => tool.name === "Bash")) {
        return { text: "Test task", toolCalls: [], stopReason: "stop", usage };
      }
      mainRequests += 1;
      if (mainRequests === 1) {
        return {
          text: "Launching the service.",
          toolCalls: [
            {
              id: "launch",
              toolName: "Bash",
              args: {
                command: "sleep 100",
                run_in_background: true,
                ...(behavior !== undefined ? { background_behavior: behavior } : {}),
              },
            },
          ],
          stopReason: "tool_use",
          usage,
        };
      }
      if (mainRequests === 2) {
        const shellId = JSON.stringify(request.messages).match(/shell_id: (bg_\w+)/)?.[1];
        expect(shellId).toBeDefined();
        return {
          text: "Inspecting the running service before using it.",
          toolCalls: [{ id: "inspect", toolName: "BashOutput", args: { shell_id: shellId } }],
          stopReason: "tool_use",
          usage,
        };
      }
      return {
        text: "Inspected the service while it is still running.",
        toolCalls: [],
        stopReason: "stop",
        usage,
      };
    }
  }
  registerProvider(provider, Provider);

  const engine = new Engine({
    llm: { provider, model: "test", apiKey: "test" } as never,
    cwd: directory,
    sessionStorageDir: join(directory, "sessions"),
    modules: [initialToolsFixtureModule(["Bash", "BashOutput"])],
    enabledBuiltinTools: [],
    headless: false,
    maxTurns: 4,
    permissionMode: "bypassPermissions",
  });
  (engine as any).hooks.clear();
  engine.registerCustomTool(bashToolDef, (args, ctx?: ToolContext) =>
    bashTool(args, { ...ctx!, backgroundShells: manager }),
  );
  engine.registerCustomTool(bashOutputToolDef, (args, ctx?: ToolContext) => {
    expect(manager.get(args.shell_id as string)?.status).toBe("running");
    inspectedWhileRunning = true;
    return bashOutputTool(args, { ...ctx!, backgroundShells: manager });
  });

  return {
    engine,
    manager,
    events,
    mainRequests: () => mainRequests,
    inspectedWhileRunning: () => inspectedWhileRunning,
    async close() {
      try {
        await manager.killAll();
        await engine.dispose();
      } finally {
        notificationQueue.reset();
        if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
        else process.env.CODE_SHELL_HOME = previousHome;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

describe("Bash background turn continuation", () => {
  test("continue executes the next actual tool step while the service is alive", async () => {
    const h = harness("continue");
    try {
      const result = await h.engine.run("Launch the service and inspect it before using its UI", {
        onStream: (event) => h.events.push(event),
      });
      expect(h.mainRequests()).toBe(3);
      expect(h.inspectedWhileRunning()).toBe(true);
      expect(result.text).toBe("Inspected the service while it is still running.");
      expect(h.manager.listForSession(result.sessionId)).toHaveLength(1);
      expect(h.manager.listForSession(result.sessionId)[0]!.status).toBe("running");
      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: "tool_result",
          result: expect.objectContaining({ toolName: "BashOutput", isError: false }),
        }),
      );
      expect(h.events).toContainEqual(
        expect.objectContaining({ type: "turn_complete", reason: "completed", text: result.text }),
      );
      expect(
        h.events.some(
          (event) => event.type === "turn_complete" && event.completionKind === "background_wait",
        ),
      ).toBe(false);
      expect(notificationQueue.getSnapshot(result.sessionId)).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  for (const behavior of [undefined, "wait_for_exit"] as const) {
    test(`${behavior ?? "omitted behavior"} keeps the finite-task wait boundary`, async () => {
      const h = harness(behavior);
      try {
        const result = await h.engine.run(
          "Launch a finite background task and wait for its result",
          {
            onStream: (event) => h.events.push(event),
          },
        );
        expect(h.mainRequests()).toBe(1);
        expect(h.inspectedWhileRunning()).toBe(false);
        expect(h.manager.listForSession(result.sessionId)[0]!.status).toBe("running");
        expect(h.events).toContainEqual(
          expect.objectContaining({
            type: "turn_complete",
            reason: "completed",
            completionKind: "background_wait",
          }),
        );
      } finally {
        await h.close();
      }
    });
  }
});
