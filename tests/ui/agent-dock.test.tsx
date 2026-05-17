import { test, expect } from "bun:test";
import React from "react";
import { mount, plainText, flush } from "../render-fixtures";
import { AgentDock } from "../../src/ui/components/AgentDock.js";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";

function reset() {
  asyncAgentRegistry.reset();
}

test("no agents → dock renders nothing", async () => {
  reset();
  const h = mount(React.createElement(AgentDock));
  await flush();
  const out = plainText(h);
  // null render → no "agents:" label in the frame
  expect(out).not.toContain("agents:");
  h.unmount();
});

test("one running agent → renders [1] description", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "abc",
    description: "review module",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const h = mount(React.createElement(AgentDock));
  await flush();
  const out = plainText(h);
  expect(out).toContain("[1]");
  expect(out).toContain("review module");
  expect(out).toContain("agents:");
  h.unmount();
});

test("completed agent → not in dock", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "abc",
    description: "review module",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.markCompleted("abc", "done");
  const h = mount(React.createElement(AgentDock));
  await flush();
  const out = plainText(h);
  expect(out).not.toContain("review module");
  h.unmount();
});

test("more than 5 agents → shows '+N more' indicator", async () => {
  reset();
  for (let i = 0; i < 7; i++) {
    asyncAgentRegistry.register({
      agentId: `a${i}`,
      description: `agent-${i}`,
      status: "running",
      startedAt: Date.now(),
      abort: () => {},
    });
  }
  // Use a wide terminal (200 cols) so all 5 visible entries + "+2 more"
  // fit on one display line without wrapping.
  const h = mount(React.createElement(AgentDock), { columns: 200 });
  await flush();
  const out = plainText(h);
  expect(out).toContain("[5]");
  expect(out).toContain("+2 more");
  h.unmount();
});
