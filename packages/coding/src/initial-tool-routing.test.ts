import { afterAll, describe, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { installLocalNetworkGuard } from "../../../scripts/runtime-cost-smoke-isolation.mjs";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME)
  throw new Error("Private HOME required");
const originalFetch = globalThis.fetch;
const originals = [http.request, http.get, https.request, https.get];
const marker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker);
installLocalNetworkGuard("http://127.0.0.1:9");
expect(() => fetch("https://coding-routing.invalid/")).toThrow("non-fixture");
expect(() => http.get("http://127.0.0.1:8/")).toThrow("non-fixture");
afterAll(() => {
  globalThis.fetch = originalFetch;
  [http.request, http.get, https.request, https.get] = originals;
  if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker);
  else delete (globalThis as any)[marker];
  syncBuiltinESMExports();
});

const { CODING_GENERAL_PRESET, CODING_TOOLS, TERMINAL_CODING_PRESET } =
  await import("./index.capability.js");
const { BUILTIN_TOOLS } = await import("@cjhyy/code-shell-core/extension");
const { routeInitialTools } = await import("../../core/src/preset/task-tool-routing.js");
const terminal = TERMINAL_CODING_PRESET;
const controls = new Set([
  "complete_goal",
  "cancel_goal",
  "SaveContextNote",
  "NewContext",
  "SearchHistory",
]);
const ordinaryEligible = terminal.builtinTools.filter((name) => !controls.has(name));
const route = (taskText: string, eligibleToolNames = ordinaryEligible) =>
  routeInitialTools({
    initialToolNames: terminal.initialToolNames,
    eligibleToolNames,
    taskText,
    policy: terminal.initialToolRouting,
  });

describe("coding package task routing policy", () => {
  test("all policy names have actual tool metadata and each preset manages its old baseline", () => {
    const names = new Set([...BUILTIN_TOOLS, ...CODING_TOOLS].map((tool) => tool.definition.name));
    for (const preset of [terminal, CODING_GENERAL_PRESET]) {
      expect(
        preset.initialToolRouting!.managedToolNames.filter((name) => !names.has(name)),
      ).toEqual([]);
      expect(
        preset.initialToolNames!.every((name) =>
          preset.initialToolRouting!.managedToolNames.includes(name),
        ),
      ).toBe(true);
      expect(preset.initialToolRouting!.rules.map((rule) => rule.id)).toEqual(
        expect.arrayContaining(["coding", "worktree", "files", "sources", "research"]),
      );
    }
    expect(
      terminal.initialToolRouting!.rules.every((rule) => !rule.toolNames.includes("Write")),
    ).toBe(true);
    expect(terminal.initialToolRouting!.managedToolNames).not.toContain("Write");
    expect(
      terminal.initialToolRouting!.rules.find((rule) => rule.id === "files")!.toolNames,
    ).toEqual(["Read", "Glob", "Grep", "view_image"]);
  });

  test.each(["修复代码并测试", "patch this bug", "edit file", "修改文件", "改配置"])(
    "%s exposes coding schemas with ApplyPatch and without Write",
    (taskText) => {
      const result = route(taskText);
      expect(result.reason).toBe("matched");
      expect(result.matchedRuleIds).toContain("coding");
      expect(result.initialToolNames).toEqual(
        expect.arrayContaining(["ApplyPatch", "Bash", "Read", "Grep", "LSP"]),
      );
      expect(result.initialToolNames).not.toContain("Write");
      expect(result.initialToolNames!.length).toBeGreaterThanOrEqual(8);
      expect(result.initialToolNames!.length).toBeLessThanOrEqual(15);
    },
  );

  test("reading files and sources does not inherit the coding edit route", () => {
    for (const taskText of ["read file", "读取资料集文档"]) {
      const result = route(taskText);
      expect(result.reason).toBe("matched");
      expect(result.matchedRuleIds).not.toContain("coding");
      expect(result.initialToolNames).not.toContain("ApplyPatch");
      expect(result.initialToolNames).not.toContain("Write");
      expect(result.initialToolNames!.length).toBeGreaterThanOrEqual(8);
      expect(result.initialToolNames!.length).toBeLessThanOrEqual(15);
    }
    expect(route("read file").initialToolNames).toContain("Read");
    expect(route("读取资料集文档").initialToolNames).toEqual(
      expect.arrayContaining(["ListSources", "ReadSource"]),
    );
  });

  test("mixed code/file intent keeps patch policy and Goal/notes controls under the cap", () => {
    const result = route("edit file patch code", terminal.builtinTools);
    expect(result.initialToolNames).toEqual(
      expect.arrayContaining([
        ...terminal.initialToolRouting!.coreToolNames,
        "ApplyPatch",
        "Bash",
        "Read",
        "Grep",
        "LSP",
      ]),
    );
    expect(result.initialToolNames!.length).toBe(15);
    expect(result.initialToolNames).not.toContain("Write");
  });

  test("routing respects the adjusted eligible worktree surface and never restores disabled tools", () => {
    const result = route(
      "worktree branch",
      ordinaryEligible
        .filter((name) => !["EnterWorktree", "ExitWorktree"].includes(name))
        .concat("SwitchSessionWorkspace"),
    );
    expect(result.initialToolNames).toContain("SwitchSessionWorkspace");
    expect(result.initialToolNames).not.toContain("EnterWorktree");
    expect(result.initialToolNames).not.toContain("ExitWorktree");
    expect(
      route(
        "fix code",
        ordinaryEligible.filter((name) => name !== "ApplyPatch"),
      ).initialToolNames,
    ).not.toContain("ApplyPatch");
  });

  test("general coding composition only routes its eligible contributed tools", () => {
    const preset = CODING_GENERAL_PRESET;
    const result = routeInitialTools({
      initialToolNames: preset.initialToolNames,
      eligibleToolNames: preset.builtinTools.filter((name) => !controls.has(name)),
      taskText: "fix code",
      policy: preset.initialToolRouting,
    });
    expect(result.reason).toBe("matched");
    expect(result.initialToolNames).toContain("DriveAgent");
    expect(result.initialToolNames).not.toContain("ApplyPatch");
    expect(result.initialToolNames).not.toContain("LSP");
    expect(result.initialToolNames!.every((name) => preset.builtinTools.includes(name))).toBe(true);
  });

  test("unknown intent and eager mode retain legacy terminal policy; custom host initial tools survive", () => {
    expect(route("hello there")).toEqual({
      initialToolNames: terminal.initialToolNames,
      reason: "no_match",
      matchedRuleIds: [],
    });
    expect(terminal.initialToolNames).toContain("ApplyPatch");
    expect(terminal.initialToolNames).not.toContain("Write");
    expect(
      routeInitialTools({
        initialToolNames: undefined,
        eligibleToolNames: terminal.builtinTools,
        taskText: "fix code",
        policy: terminal.initialToolRouting,
      }).reason,
    ).toBe("legacy");
    const initialToolNames = [...terminal.initialToolNames!, "CustomHostTool"];
    const result = routeInitialTools({
      initialToolNames,
      eligibleToolNames: [...terminal.builtinTools, "CustomHostTool"],
      taskText: "patch code",
      policy: terminal.initialToolRouting,
    });
    expect(result.initialToolNames).toContain("CustomHostTool");
    expect(
      result.initialToolNames!.filter((name) => name !== "CustomHostTool").length,
    ).toBeLessThanOrEqual(15);
  });
});
