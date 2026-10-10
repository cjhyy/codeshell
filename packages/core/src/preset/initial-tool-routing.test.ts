import { afterAll, describe, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";
import type { ToolVisibilityContext } from "../tool-system/context.js";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME)
  throw new Error("Private HOME required");
const originalFetch = globalThis.fetch;
const originals = [http.request, http.get, https.request, https.get];
const marker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker);
installLocalNetworkGuard("http://127.0.0.1:9");
expect(() => fetch("https://routing.invalid/")).toThrow("non-fixture");
expect(() => http.get("http://127.0.0.1:8/")).toThrow("non-fixture");
afterAll(() => {
  globalThis.fetch = originalFetch;
  [http.request, http.get, https.request, https.get] = originals;
  if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker);
  else delete (globalThis as any)[marker];
  syncBuiltinESMExports();
});

const { BUILTIN_AGENT_PRESETS } = await import("./index.js");
const { routeInitialTools } = await import("./task-tool-routing.js");
const { BUILTIN_TOOLS, BUILTIN_TOOL_GUARDS } = await import("../tool-system/builtin/index.js");
const registered = new Set(BUILTIN_TOOLS.map((tool) => tool.definition.name));
const visibility: ToolVisibilityContext = {
  cwd: process.env.HOME,
  hasGoal: false,
  contextStrategy: "summary",
};
const general = BUILTIN_AGENT_PRESETS.general;

function eligible(names: readonly string[]) {
  return names.filter((name) => BUILTIN_TOOL_GUARDS.get(name)?.(visibility) !== false);
}

describe("first-party initial tool routing policies", () => {
  test("policies manage their legacy baseline and reference registered domain-neutral tools", () => {
    for (const preset of Object.values(BUILTIN_AGENT_PRESETS)) {
      const policy = preset.initialToolRouting!;
      expect(policy).toBeDefined();
      expect(preset.initialToolNames!.every((name) => policy.managedToolNames.includes(name))).toBe(
        true,
      );
      expect(policy.managedToolNames.filter((name) => !registered.has(name))).toEqual([]);
      expect(policy.coreToolNames).toEqual(
        expect.arrayContaining([
          "ToolSearch",
          "AskUserQuestion",
          "AskUserQuestionAsync",
          "Agent",
          "TodoWrite",
          "complete_goal",
          "cancel_goal",
          "SaveContextNote",
          "NewContext",
          "SearchHistory",
        ]),
      );
      expect(policy.managedToolNames).not.toContain("ApplyPatch");
      expect(policy.managedToolNames).not.toContain("LSP");
      expect(policy.rules.find((rule) => rule.id === "files")!.toolNames).toContain("view_image");
      expect(policy.rules.map((rule) => rule.id)).toEqual([
        "research",
        "sources",
        "files",
        "automation",
        "history",
      ]);
    }
  });

  test.each([
    ["Research web websites", "research"],
    ["读取资料集附件", "sources"],
    ["Read file", "files"],
    ["定时提醒", "automation"],
    ["查看历史记忆", "history"],
  ])("%s uses a bounded initial set without bypassing real availability", (taskText, ruleId) => {
    for (const preset of Object.values(BUILTIN_AGENT_PRESETS)) {
      const eligibleToolNames = eligible(preset.builtinTools);
      const result = routeInitialTools({
        initialToolNames: preset.initialToolNames,
        eligibleToolNames,
        taskText,
        policy: preset.initialToolRouting,
      });
      expect(result.reason).toBe("matched");
      expect(result.matchedRuleIds).toContain(ruleId);
      expect(result.initialToolNames!.length).toBeGreaterThanOrEqual(8);
      expect(result.initialToolNames!.length).toBeLessThanOrEqual(15);
      expect(result.initialToolNames!.every((name) => eligibleToolNames.includes(name))).toBe(true);
      expect(result.initialToolNames).toEqual(
        expect.arrayContaining([
          "ToolSearch",
          "AskUserQuestion",
          "AskUserQuestionAsync",
          "Agent",
          "TodoWrite",
        ]),
      );
      for (const name of [
        "complete_goal",
        "cancel_goal",
        "SaveContextNote",
        "NewContext",
        "SearchHistory",
      ])
        expect(result.initialToolNames).not.toContain(name);
    }
  });

  test("research and source intent load different actual tools; unavailable WebSearch stays hidden", () => {
    const eligibleToolNames = eligible(general.builtinTools);
    const route = (taskText: string) =>
      routeInitialTools({
        initialToolNames: general.initialToolNames,
        eligibleToolNames,
        taskText,
        policy: general.initialToolRouting,
      }).initialToolNames!;
    expect(route("research websites")).toContain("WebFetch");
    expect(route("读取资料集文档")).toEqual(expect.arrayContaining(["ListSources", "ReadSource"]));
    expect(route("读取资料集文档")).not.toContain("WebFetch");
    expect(route("research websites").includes("WebSearch")).toBe(
      eligibleToolNames.includes("WebSearch"),
    );
  });

  test("mixed intent preserves eligible Goal and notes controls inside the first-party cap", () => {
    const result = routeInitialTools({
      initialToolNames: general.initialToolNames,
      eligibleToolNames: general.builtinTools,
      taskText: "research web sources",
      policy: general.initialToolRouting,
    });
    expect(result.reason).toBe("matched");
    expect(result.initialToolNames).toEqual(
      expect.arrayContaining([
        ...general.initialToolRouting!.coreToolNames,
        "WebSearch",
        "WebFetch",
        "ListSources",
        "ReadSource",
      ]),
    );
    expect(result.initialToolNames!.length).toBeLessThanOrEqual(15);
    expect(result.initialToolNames).not.toContain("Bash");
  });

  test("unknown intent, eager presets and presets without a policy retain their legacy initial object", () => {
    const input = {
      initialToolNames: general.initialToolNames,
      eligibleToolNames: general.builtinTools,
      taskText: "hello there",
      policy: general.initialToolRouting,
    };
    expect(routeInitialTools(input)).toEqual({
      initialToolNames: general.initialToolNames,
      reason: "no_match",
      matchedRuleIds: [],
    });
    expect(routeInitialTools({ ...input, taskText: "resourcefulness" }).reason).toBe("no_match");
    expect(routeInitialTools({ ...input, policy: undefined }).initialToolNames).toBe(
      input.initialToolNames,
    );
    expect(
      routeInitialTools({ ...input, initialToolNames: undefined, taskText: "research web" }),
    ).toEqual({ initialToolNames: undefined, reason: "legacy", matchedRuleIds: [] });
  });

  test("inherited host initial names are retained, while ineligible extras are not introduced", () => {
    const initialToolNames = [...general.initialToolNames!, "HostCustom", "HostDenied"];
    const result = routeInitialTools({
      initialToolNames,
      eligibleToolNames: [...general.builtinTools, "HostCustom"],
      taskText: "research web sources",
      policy: general.initialToolRouting,
    });
    expect(result.reason).toBe("matched");
    expect(result.initialToolNames).toContain("HostCustom");
    expect(result.initialToolNames).not.toContain("HostDenied");
    expect(
      result.initialToolNames!.filter((name) => name !== "HostCustom").length,
    ).toBeLessThanOrEqual(15);
    expect(initialToolNames).toEqual([...general.initialToolNames!, "HostCustom", "HostDenied"]);
  });
});
