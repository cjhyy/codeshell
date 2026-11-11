import { describe, expect, test } from "bun:test";
import { HookRegistry } from "../hooks/registry.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { RunToolSurface } from "../tool-system/run-tool-surface.js";
import type { ToolContext } from "../tool-system/context.js";
import type { LLMResponse, Message, StreamEvent, ToolCall } from "../types.js";
import { TurnLoop, type TurnLoopDeps } from "./turn-loop.js";

for (const toolName of ["complete_goal", "cancel_goal"]) {
  describe(`CallTool ${toolName} terminal state`, () => {
    for (const outcome of ["denied", "invalid", "allowed"] as const) {
      test(`${outcome} execution only clears the goal after a successful result`, async () => {
        const registry = new ToolRegistry({ builtinTools: ["ToolSearch", toolName] });
        const surface = new RunToolSurface(["ToolSearch"]);
        surface.updateCatalog(registry.getToolDefinitions());
        surface.select([toolName]);
        const hooks = new HookRegistry();
        const permission = new PermissionClassifier(
          [{ tool: "*", decision: outcome === "denied" ? "deny" : "allow" }],
          "default",
        );
        const executor = new ToolExecutor(registry, permission, hooks);
        executor.setContext({
          cwd: process.cwd(),
          runToolSurface: surface,
          toolVisibility: { cwd: process.cwd(), hasGoal: true },
        } as ToolContext);
        const args =
          toolName === "complete_goal"
            ? { summary: outcome === "invalid" ? 42 : "done" }
            : outcome === "invalid"
              ? { confirm: true }
              : { confirm: true, reason: "user asked to stop" };
        const wire: ToolCall = {
          id: "goal-wrapper",
          toolName: "CallTool",
          args: { name: toolName, args },
        };
        const response: LLMResponse = { text: "", stopReason: "tool_use", toolCalls: [wire] };
        let cleared = 0;
        const events: StreamEvent[] = [];
        const deps: TurnLoopDeps = {
          model: {
            call: async () => response,
            callWithoutStreaming: async () => response,
            getUsage: () => ({
              records: [],
              totalPromptTokens: 0,
              totalCompletionTokens: 0,
              totalTokens: 0,
              requestCount: 0,
            }),
            getOutputTokens: () => 0,
          } as unknown as TurnLoopDeps["model"],
          toolExecutor: executor,
          contextManager: {
            manageAsync: async (messages: Message[]) => messages,
            manage: (messages: Message[]) => messages,
            recordActualUsage() {},
            shouldReactiveCompact: () => false,
          } as unknown as TurnLoopDeps["contextManager"],
          hooks,
          transcript: {
            appendToolUse() {},
            appendToolResult() {},
            appendTurnBoundary() {},
            appendMessage() {},
          } as unknown as TurnLoopDeps["transcript"],
          systemPrompt: "system",
          tools: surface.snapshot(),
          runToolSurface: surface,
          sessionId: "wrapped-goal-result-test",
          clearPersistedGoal: () => {
            cleared++;
          },
          ctxOverheadStore: { get: () => 0, set: () => {} },
        };
        await new TurnLoop(deps, {
          maxTurns: 1,
          maxToolCallsPerTurn: 10,
          goal: { objective: "finish", goalId: "goal-wrapper-test" } as never,
          onStream: (event) => events.push(event),
        }).run([{ role: "user", content: "go" }]);
        const result = events.find((event) => event.type === "tool_result")?.result;
        expect(result?.toolName).toBe(toolName);
        if (outcome === "allowed") {
          expect(result?.isError).toBeFalsy();
          expect(cleared).toBe(1);
        } else {
          expect(result?.isError).toBe(true);
          expect(result?.error).toMatch(outcome === "denied" ? /denied/i : /invalid input/i);
          expect(cleared).toBe(0);
          expect(
            events.some(
              (event) =>
                event.type === "goal_cleared" ||
                (event.type === "goal_progress" && event.status === "met"),
            ),
          ).toBe(false);
        }
      });
    }
  });
}
