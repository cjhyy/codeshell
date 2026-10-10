import { describe, expect, test } from "bun:test";
import { routeInitialTools, type TaskToolRoutingPolicy } from "./task-tool-routing.js";
import { initializeRunToolSurface } from "../engine/run-tooling.js";
import type { ToolContext } from "../tool-system/context.js";
import type { ToolDefinition } from "../types.js";

const managed = ["ToolSearch", "Ask", ...Array.from({ length: 18 }, (_, i) => `Tool${i}`)];
const initial = managed.slice(0, 10);

function policy(overrides: Partial<TaskToolRoutingPolicy> = {}): TaskToolRoutingPolicy {
  return {
    managedToolNames: managed,
    coreToolNames: ["ToolSearch", "Ask"],
    rules: [
      { id: "alpha", terms: ["alpha", "first"], toolNames: ["Tool12", "Tool13"] },
      { id: "beta", terms: ["beta", "second"], toolNames: ["Tool14", "Tool15"] },
      { id: "chinese", terms: ["整理资料"], toolNames: ["Tool16"] },
    ],
    ...overrides,
  };
}

function route(taskText: string, overrides: Partial<Parameters<typeof routeInitialTools>[0]> = {}) {
  return routeInitialTools({
    initialToolNames: initial,
    eligibleToolNames: managed,
    taskText,
    policy: policy(),
    ...overrides,
  });
}

describe("Preset task schema routing", () => {
  test("scores distinct terms before declaration order, then fills the minimum", () => {
    const result = route("alpha beta second");
    expect(result.reason).toBe("matched");
    expect(result.matchedRuleIds).toEqual(["beta", "alpha"]);
    expect(result.initialToolNames).toEqual([
      "ToolSearch",
      "Ask",
      "Tool14",
      "Tool15",
      "Tool12",
      "Tool13",
      "Tool0",
      "Tool1",
    ]);
    expect(route("alpha beta").matchedRuleIds).toEqual(["alpha", "beta"]);
  });

  test("normalizes NFKC and case, but rejects ASCII substring false matches", () => {
    expect(route("ＡＬＰＨＡ").matchedRuleIds).toEqual(["alpha"]);
    expect(route("alphabet _alpha alpha2").reason).toBe("no_match");
    expect(route("(ALPHA), then first.").matchedRuleIds).toEqual(["alpha"]);
    expect(route("请先整理资料再回答").matchedRuleIds).toEqual(["chinese"]);
  });

  test("repeated occurrences and normalized duplicate terms do not inflate score", () => {
    const result = route("alpha alpha alpha beta second", {
      policy: policy({
        rules: [
          { id: "duplicates", terms: ["alpha", "ALPHA", "ａｌｐｈａ"], toolNames: ["Tool12"] },
          { id: "distinct", terms: ["beta", "second"], toolNames: ["Tool14"] },
        ],
      }),
    });
    expect(result.matchedRuleIds).toEqual(["distinct", "duplicates"]);
  });

  test("keeps inherited additions beyond the managed maximum without granting unknown tools", () => {
    const extras = Array.from({ length: 8 }, (_, i) => `Fixture${i}`);
    const result = route("alpha", {
      initialToolNames: [...initial, ...extras, "Unavailable"],
      eligibleToolNames: [...managed, ...extras],
      policy: policy({
        rules: [{ id: "wide", terms: ["alpha"], toolNames: managed }],
      }),
    });
    expect(result.initialToolNames).toHaveLength(23);
    expect(result.initialToolNames!.slice(0, 15)).toEqual(managed.slice(0, 15));
    expect(result.initialToolNames!.slice(15)).toEqual(extras);
    expect(result.initialToolNames).not.toContain("Unavailable");
  });

  test("intersects eligibility and does not invent tools to reach the minimum", () => {
    const result = route("alpha", { eligibleToolNames: ["ToolSearch", "Tool12"] });
    expect(result.initialToolNames).toEqual(["ToolSearch", "Tool12"]);
  });

  test("counts automatic discovery even when policy omits it and never duplicates extras", () => {
    const pool = managed.filter((name) => name !== "ToolSearch");
    const result = route("alpha", {
      initialToolNames: ["ToolSearch", ...initial],
      policy: policy({
        managedToolNames: pool,
        coreToolNames: ["Ask"],
        rules: [{ id: "wide", terms: ["alpha"], toolNames: pool }],
      }),
    });
    expect(result.initialToolNames).toHaveLength(15);
    expect(result.initialToolNames![0]).toBe("ToolSearch");
    expect(new Set(result.initialToolNames).size).toBe(15);
  });

  test("reserves discovery capacity without truncating declared core tools", () => {
    const withoutSearch = managed.filter((name) => name !== "ToolSearch").slice(0, 15);
    const tooMany = route("alpha", {
      policy: policy({ coreToolNames: withoutSearch }),
    });
    expect(tooMany.reason).toBe("invalid_policy");
    expect(tooMany.initialToolNames).toBe(initial);
    expect(tooMany.matchedRuleIds).toEqual([]);

    const fourteen = withoutSearch.slice(0, 14);
    const automaticSearch = route("alpha", {
      policy: policy({ coreToolNames: fourteen }),
    });
    expect(automaticSearch.reason).toBe("matched");
    expect(automaticSearch.initialToolNames).toEqual(["ToolSearch", ...fourteen]);
    expect(automaticSearch.initialToolNames).toHaveLength(15);

    const withSearch = ["ToolSearch", ...fourteen];
    const declaredSearch = route("alpha", {
      policy: policy({ coreToolNames: withSearch }),
    });
    expect(declaredSearch.reason).toBe("matched");
    expect(declaredSearch.initialToolNames).toEqual(withSearch);
    expect(declaredSearch.initialToolNames).toHaveLength(15);
  });

  test("uses the unchanged legacy initial set for unmatched and bounded-away text", () => {
    for (const text of ["unmatched", `${"x".repeat(16_384)} alpha`]) {
      const result = route(text);
      expect(result.reason).toBe("no_match");
      expect(result.initialToolNames).toBe(initial);
      expect(result.matchedRuleIds).toEqual([]);
    }
  });

  test("keeps undefined initial, missing policy and absent discovery on legacy paths", () => {
    expect(route("alpha", { initialToolNames: undefined })).toEqual({
      initialToolNames: undefined,
      reason: "legacy",
      matchedRuleIds: [],
    });
    expect(route("alpha", { policy: undefined }).initialToolNames).toBe(initial);
    expect(route("alpha", { eligibleToolNames: ["Tool12"] }).reason).toBe("legacy");
  });

  test("rejects regex syntax, malformed and over-budget policies without truncating legacy names", () => {
    const invalid = [
      policy({ minInitialTools: 7 }),
      policy({ maxInitialTools: 16 }),
      policy({ minInitialTools: 10, maxInitialTools: 9 }),
      policy({ coreToolNames: ["Unknown"] }),
      policy({ managedToolNames: new Array(3) }),
      policy({ managedToolNames: Array.from({ length: 129 }, (_, i) => `Name${i}`) }),
      policy({ rules: [{ id: "regex", terms: ["alpha.*"], toolNames: ["Tool12"] }] }),
      policy({ rules: [{ id: "unknown", terms: ["alpha"], toolNames: ["Unknown"] }] }),
      policy({ rules: [{ id: "unsafe\nraw", terms: ["alpha"], toolNames: [] }] }),
      policy({
        rules: Array.from({ length: 33 }, (_, i) => ({
          id: `id${i}`,
          terms: ["alpha"],
          toolNames: [],
        })),
      }),
      policy({ rules: [{ id: "long", terms: ["a".repeat(129)], toolNames: [] }] }),
      policy({
        rules: [
          { id: "many", terms: Array.from({ length: 33 }, (_, i) => `word${i}`), toolNames: [] },
        ],
      }),
      policy({
        rules: Array.from({ length: 9 }, (_, i) => ({
          id: `id${i}`,
          terms: Array.from({ length: 32 }, (_, j) => `word${j}`),
          toolNames: [],
        })),
      }),
      policy({
        rules: [
          { id: "same", terms: ["alpha"], toolNames: [] },
          { id: "same", terms: ["beta"], toolNames: [] },
        ],
      }),
      null as unknown as TaskToolRoutingPolicy,
    ];
    for (const value of invalid) {
      const result = route("alpha", { policy: value });
      expect(result.reason).toBe("invalid_policy");
      expect(result.initialToolNames).toBe(initial);
      expect(result.matchedRuleIds).toEqual([]);
    }
  });

  test("does not mutate preset declarations or eligible inputs", () => {
    const frozenPolicy = Object.freeze(policy());
    const before = JSON.stringify(frozenPolicy);
    const eligible = Object.freeze([...managed]);
    route("alpha beta", { policy: frozenPolicy, eligibleToolNames: eligible });
    expect(JSON.stringify(frozenPolicy)).toBe(before);
    expect(eligible).toEqual(managed);
  });

  test("initializes once while refresh retains selection and recomputes only eligibility", () => {
    const ctx = {} as ToolContext;
    let available = [...managed];
    const definitions = () =>
      available.map((name): ToolDefinition => ({ name, description: name, inputSchema: {} }));
    const catalog = initializeRunToolSurface(ctx, initial, definitions, {
      taskText: "alpha",
      policy: policy(),
    });
    expect(catalog.map((definition) => definition.name)).toEqual(managed);
    const first = ctx.refreshRunTools!();
    expect(first.map((definition) => definition.name)).toContain("Tool12");
    expect(first.map((definition) => definition.name)).not.toContain("Tool14");
    ctx.runToolSurface!.select(["Tool14"]);
    available = managed.filter((name) => name !== "Tool12");
    const second = ctx.refreshRunTools!();
    expect(second.map((definition) => definition.name)).toContain("Tool14");
    expect(second.map((definition) => definition.name)).not.toContain("Tool12");
    expect(first.map((definition) => definition.name)).toContain("Tool12");
    available = [...managed];
    expect(ctx.refreshRunTools!().map((definition) => definition.name)).toContain("Tool12");
  });
});
