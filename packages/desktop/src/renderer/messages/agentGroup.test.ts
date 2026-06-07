import { describe, expect, test } from "bun:test";
import { summarizeAgentGroup, foldAgentGroups, type AgentGroup } from "./agentGroup";
import type { StreamItem, TurnProcessGroup } from "./streamGroups";
import type { AgentMessage } from "../types";

const agent = (id: string, o: Partial<AgentMessage> = {}): AgentMessage => ({
  kind: "agent",
  id,
  description: id,
  done: false,
  startedAt: 0,
  toolCalls: [],
  textBuffer: "",
  toolCount: 0,
  ...o,
});

describe("summarizeAgentGroup", () => {
  test("counts succeeded / failed / running", () => {
    const s = summarizeAgentGroup([
      agent("a", { done: true, endedAt: 100, startedAt: 10, toolCount: 4 }),
      agent("b", { error: "boom", done: true, endedAt: 50, startedAt: 20, toolCount: 3 }),
      agent("c", { done: false, startedAt: 30, toolCount: 1 }),
    ]);
    expect(s.total).toBe(3);
    expect(s.succeeded).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.running).toBe(1);
    expect(s.toolTotal).toBe(8);
  });

  test("wallMs = latest end − earliest start when all done (parallel-aware)", () => {
    const s = summarizeAgentGroup([
      agent("a", { done: true, startedAt: 100, endedAt: 400 }),
      agent("b", { done: true, startedAt: 150, endedAt: 600 }),
    ]);
    expect(s.wallMs).toBe(500); // 600 − 100, not (300+450)
  });

  test("wallMs is 0 while any member runs", () => {
    const s = summarizeAgentGroup([
      agent("a", { done: true, startedAt: 100, endedAt: 400 }),
      agent("b", { done: false, startedAt: 150 }),
    ]);
    expect(s.wallMs).toBe(0);
  });
});

describe("foldAgentGroups", () => {
  const user: StreamItem = { kind: "user", id: "u", text: "hi" } as StreamItem;

  test("≥2 adjacent agents → one agent_group", () => {
    const out = foldAgentGroups([agent("a"), agent("b"), agent("c")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("agent_group");
    expect((out[0] as AgentGroup).agents.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(out[0]!.id).toBe("ag-a");
  });

  test("a single agent is left as a plain agent item", () => {
    const out = foldAgentGroups([agent("solo")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("agent");
  });

  test("a non-agent item breaks the run into separate groups", () => {
    const out = foldAgentGroups([agent("a"), agent("b"), user, agent("c"), agent("d")]);
    expect(out.map((i) => i.kind)).toEqual(["agent_group", "user", "agent_group"]);
  });

  test("passes non-agent items through untouched", () => {
    const out = foldAgentGroups([user]);
    expect(out).toEqual([user]);
  });

  test("recurses into turn_process_group.items", () => {
    const tpg: TurnProcessGroup = {
      kind: "turn_process_group",
      id: "process-x",
      durationMs: 0,
      firstToolStartedAt: 0,
      isLive: false,
      toolCount: 0,
      items: [agent("a"), agent("b")],
    };
    const out = foldAgentGroups([tpg]);
    expect(out).toHaveLength(1);
    const inner = (out[0] as TurnProcessGroup).items;
    expect(inner).toHaveLength(1);
    expect(inner[0]!.kind).toBe("agent_group");
  });

  test("empty input → empty output", () => {
    expect(foldAgentGroups([])).toEqual([]);
  });
});
