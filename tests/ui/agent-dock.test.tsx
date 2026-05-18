import { test, expect } from "bun:test";
import React from "react";
import { mount, plainText, flush } from "../render-fixtures";
import {
  AgentDock,
  formatElapsed,
  getVisibleAgents,
} from "../../src/ui/components/AgentDock.js";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";

function reset() {
  asyncAgentRegistry.reset();
}

const VIEW_MAIN = { kind: "main" as const };

test("no agents → dock renders nothing", async () => {
  reset();
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
  );
  await flush();
  const out = plainText(h);
  expect(out).not.toContain("agents");
  h.unmount();
});

test("one running agent → row shows name and elapsed, no tool name", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "abc",
    description: "review module",
    status: "running",
    startedAt: Date.now() - 5_000,
    abort: () => {},
  });
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
    { columns: 80 },
  );
  await flush();
  const out = plainText(h);
  expect(out).toContain("review module");
  expect(out).toMatch(/[45]s/);
  expect(out).not.toContain("Bash");
  expect(out).not.toContain("Read");
  h.unmount();
});

test("focusedIndex 0 shows '>' cursor on first row", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "first agent",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2",
    description: "second agent",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: 0 }),
    { columns: 80 },
  );
  await flush();
  const out = plainText(h);
  expect(out).toMatch(/>\s*●\s*first agent/);
  expect(out).not.toMatch(/>\s*●\s*second agent/);
  h.unmount();
});

test("completed agent within fade window → still visible", async () => {
  reset();
  const start = Date.now();
  asyncAgentRegistry.register({
    agentId: "lingers",
    description: "linger row",
    status: "running",
    startedAt: start,
    abort: () => {},
  });
  asyncAgentRegistry.markCompleted("lingers", "done");
  const a = asyncAgentRegistry
    .getSnapshot()
    .find((x) => x.agentId === "lingers");
  expect(a?.finishedFadeAt).toBeGreaterThan(Date.now());

  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
    { columns: 80 },
  );
  await flush();
  const out = plainText(h);
  expect(out).toContain("linger row");
  h.unmount();
});

test("getVisibleAgents filter excludes agents past finishedFadeAt", () => {
  const now = 1_000_000;
  const all = [
    {
      agentId: "running",
      description: "r",
      status: "running",
      startedAt: 0,
      abort: () => {},
    },
    {
      agentId: "linger",
      description: "l",
      status: "completed",
      startedAt: 0,
      finishedAt: now - 1_000,
      finishedFadeAt: now + 29_000,
      abort: () => {},
    },
    {
      agentId: "gone",
      description: "g",
      status: "completed",
      startedAt: 0,
      finishedAt: now - 31_000,
      finishedFadeAt: now - 1_000,
      abort: () => {},
    },
  ] as any[];
  const visible = getVisibleAgents(all, now);
  expect(visible.map((a) => a.agentId)).toEqual(["running", "linger"]);
});

test("more than 5 agents → '+N more' overflow indicator", async () => {
  reset();
  for (let i = 0; i < 7; i++) {
    asyncAgentRegistry.register({
      agentId: `o${i}`,
      description: `agent-${i}`,
      status: "running",
      startedAt: Date.now(),
      abort: () => {},
    });
  }
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
    { columns: 200 },
  );
  await flush();
  const out = plainText(h);
  expect(out).toContain("agent-4");
  expect(out).not.toContain("agent-5");
  expect(out).toContain("+2 more");
  h.unmount();
});

test("formatElapsed covers s, m s, h m s boundaries", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(59_000)).toBe("59s");
  expect(formatElapsed(60_000)).toBe("1m 0s");
  expect(formatElapsed(4 * 60_000 + 23_000)).toBe("4m 23s");
  expect(formatElapsed(60 * 60_000)).toBe("1h 0m 0s");
  expect(formatElapsed(3_600_000 + 4 * 60_000 + 23_000)).toBe("1h 4m 23s");
});

test("agent rows have visual separation (blank line between them)", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "first agent",
    status: "running",
    startedAt: 10,
    abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2",
    description: "second agent",
    status: "running",
    startedAt: 20,
    abort: () => {},
  });
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
    { columns: 80, rows: 30 },
  );
  await flush();
  // Use dumpFrames (raw output) + ANSI strip, then split into display lines.
  const raw = h.frames.join("");
  const stripped = raw
    .replace(/\x1b\[(\d+)C/g, (_m, n) => " ".repeat(Number(n)))
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b/g, "");
  const lines = stripped.split(/\r?\n/);
  const i1 = lines.findIndex((l) => l.includes("first agent"));
  const i2 = lines.findIndex((l) => l.includes("second agent"));
  expect(i1).toBeGreaterThanOrEqual(0);
  expect(i2).toBeGreaterThan(i1);
  // At least one blank-ish line between the two agent rows (marginTop=1).
  // "blank-ish" = no agent description text.
  let foundGap = false;
  for (let j = i1 + 1; j < i2; j++) {
    const trimmed = lines[j].trim();
    if (trimmed === "" || (!trimmed.includes("first agent") && !trimmed.includes("second agent") && !trimmed.includes("●"))) {
      foundGap = true;
      break;
    }
  }
  expect(foundGap).toBe(true);
  h.unmount();
});
