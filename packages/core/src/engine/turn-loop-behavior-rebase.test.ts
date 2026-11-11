import { describe, expect, test } from "bun:test";
import type { LLMResponse, Message, ToolCall, ToolDefinition, ToolResult } from "../types.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";
import { PromptComposer } from "../prompt/composer.js";
import { callToolDef } from "../tool-system/builtin/call-tool.js";
import { RunToolSurface } from "../tool-system/run-tool-surface.js";
import { TurnLoop, type TurnLoopDeps } from "./turn-loop.js";

const definition = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
});
const discovery = definition("ToolSearch");
const pulse = definition("Pulse");
const browser = definition("browser_navigate");

describe("TurnLoop refreshes frozen behavior at cold boundaries", () => {
  test.each(["call-tool", "tool-reference"] as const)(
    "%s preserves warm instructions and refreshes a behavior-only rebase without rewriting tools",
    async (toolDiscovery) => {
      const surface = new RunToolSurface([discovery.name, pulse.name], {
        toolDiscovery,
        // A provider-incompatible declaration still uses CallTool and needs its
        // instructions. This keeps the native request directory unchanged too.
        canExposeDefinition: (tool) => tool.name !== browser.name,
      });
      const eligibleWithoutBrowser = [discovery, pulse, callToolDef];
      surface.updateCatalog([...eligibleWithoutBrowser, browser]);
      const composer = new PromptComposer({
        cwd: process.cwd(),
        model: "test-model",
        preset: BUILTIN_AGENT_PRESETS.general,
        toolDiscovery,
        behaviorToolNames: surface.behaviorSnapshot(),
      });
      const initialTools = surface.requestSnapshot();
      const initialToolBytes = JSON.stringify(initialTools);
      const initialPrompt = await composer.buildSystemPrompt(surface.snapshot());
      let managedTurn = 0;
      const rebuildTurns: number[] = [];
      const serializedToolTurns: number[] = [];
      const requests: Array<{ systemPrompt: string; tools: ToolDefinition[]; rebuilds: number }> =
        [];
      const executed: string[] = [];
      const observedArrays = new WeakMap<ToolDefinition[], ToolDefinition[]>();
      const getTools = () => {
        const snapshot = surface.requestSnapshot();
        let observed = observedArrays.get(snapshot);
        if (!observed) {
          // Observe only this fixture's arrays, never patch process-global JSON.
          observed = new Proxy(snapshot, {
            get(target, property, receiver) {
              if (property === "toJSON") serializedToolTurns.push(managedTurn);
              return Reflect.get(target, property, receiver);
            },
          });
          observedArrays.set(snapshot, observed);
        }
        return observed;
      };
      const call = async (
        systemPrompt: string,
        _messages: Message[],
        tools: ToolDefinition[],
      ): Promise<LLMResponse> => {
        requests.push({ systemPrompt, tools, rebuilds: rebuildTurns.length });
        return requests.length < 3
          ? {
              text: "",
              toolCalls: [{ id: `pulse-${requests.length}`, toolName: pulse.name, args: {} }],
              stopReason: "tool_use",
            }
          : { text: "done", toolCalls: [], stopReason: "end_turn" };
      };
      const deps: TurnLoopDeps = {
        model: {
          call,
          callWithoutStreaming: call,
          getUsage: () => ({
            records: [],
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalTokens: 0,
            requestCount: 0,
          }),
          getOutputTokens: () => 0,
        } as unknown as TurnLoopDeps["model"],
        toolExecutor: {
          setLogger() {},
          getInvestigationGuard: () => undefined,
          getTaskGuard: () => undefined,
          isConcurrencySafe: () => false,
          async executeSingle(tool: ToolCall): Promise<ToolResult> {
            executed.push(tool.id);
            return { id: tool.id, toolName: tool.toolName, result: "ok" };
          },
        } as unknown as TurnLoopDeps["toolExecutor"],
        contextManager: {
          async manageAsync(messages: Message[]) {
            managedTurn++;
            if (managedTurn === 2) surface.updateCatalog(eligibleWithoutBrowser);
            if (managedTurn === 3) surface.rebase();
            return messages;
          },
          manage: (messages: Message[]) => messages,
          recordActualUsage() {},
          shouldReactiveCompact: () => false,
        } as unknown as TurnLoopDeps["contextManager"],
        hooks: {
          async emit() {
            return {};
          },
        } as unknown as TurnLoopDeps["hooks"],
        transcript: {
          appendToolUse() {},
          appendToolResult() {},
          appendTurnBoundary() {},
          appendMessage() {},
        } as unknown as TurnLoopDeps["transcript"],
        systemPrompt: initialPrompt,
        tools: getTools(),
        getTools,
        runToolSurface: surface,
        getSystemPrompt: async (eager) => {
          rebuildTurns.push(managedTurn);
          return composer.buildSystemPrompt(eager, surface.behaviorSnapshot());
        },
        sessionId: "behavior-rebase",
        ctxOverheadStore: { get: () => 0, set() {} },
      };

      const result = await new TurnLoop(deps, { maxTurns: 8, maxToolCallsPerTurn: 10 }).run([
        { role: "user", content: "continue across the cache boundary" },
      ]);
      expect(result.reason).toBe("completed");
      expect(requests).toHaveLength(3);
      expect(executed).toEqual(["pulse-1", "pulse-2"]);
      expect(requests[0]!.systemPrompt).toContain("## Browser automation");
      expect(requests[1]!.systemPrompt).toBe(requests[0]!.systemPrompt);
      expect(requests[1]!.rebuilds).toBe(requests[0]!.rebuilds);
      expect(requests[1]!.tools).toBe(requests[0]!.tools);
      expect(requests[2]!.rebuilds).toBe(requests[1]!.rebuilds + 1);
      expect(rebuildTurns).toContain(3);
      expect(requests[2]!.systemPrompt).not.toContain("## Browser automation");
      expect(requests[2]!.systemPrompt).toContain("\nToolSearch, Pulse, CallTool\n");
      expect(serializedToolTurns).not.toContain(2);
      for (const request of requests) expect(JSON.stringify(request.tools)).toBe(initialToolBytes);
      expect(surface.isEligible(browser.name)).toBe(false);
    },
  );
});
