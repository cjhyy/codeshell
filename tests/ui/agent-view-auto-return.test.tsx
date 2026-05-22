import { test, expect } from "bun:test";
import React, { useState, useEffect, useSyncExternalStore, useImperativeHandle, forwardRef } from "react";
import { Box } from "../../packages/tui/src/render/index.js";
import { mount, flush } from "../render-fixtures";
import { asyncAgentRegistry } from "../../packages/core/src/tool-system/builtin/agent-registry.js";

type ViewMode = { kind: "main" } | { kind: "agent"; agentId: string };

interface HostHandle {
  viewMode: ViewMode;
}

/**
 * Minimal fixture re-implementing the auto-return effect from App.tsx.
 * Keeps the test free of the App's many unrelated dependencies.
 */
const Host = forwardRef<HostHandle, { initialViewMode: ViewMode }>(
  function Host({ initialViewMode }, ref) {
    const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
    const agentsSnapshot = useSyncExternalStore(
      asyncAgentRegistry.subscribe,
      asyncAgentRegistry.getSnapshot,
    );
    useEffect(() => {
      if (viewMode.kind !== "agent") return;
      const entry = agentsSnapshot.find((a) => a.agentId === viewMode.agentId);
      if (!entry || entry.status !== "running") {
        setViewMode({ kind: "main" });
      }
    }, [agentsSnapshot, viewMode]);
    useImperativeHandle(ref, () => ({ viewMode }), [viewMode]);
    return <Box />;
  },
);

function reset() {
  asyncAgentRegistry.reset();
}

// Wait twice — once for the React state commit triggered by the registry
// notify, and again so the auto-return effect scheduled by that commit can
// run before the test inspects the ref.
async function settle() {
  await flush();
  await flush();
}

test("viewMode falls back to main when focused agent leaves running", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "watch-me",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const ref = React.createRef<HostHandle>();
  const h = mount(
    React.createElement(Host, {
      ref,
      initialViewMode: { kind: "agent", agentId: "watch-me" },
    }),
  );
  await settle();
  // Still running → still in agent view.
  expect(ref.current?.viewMode.kind).toBe("agent");

  asyncAgentRegistry.markCompleted("watch-me");
  await settle();

  // The dock row lingers 30s, but viewMode flips immediately.
  expect(ref.current?.viewMode.kind).toBe("main");
  // And the entry is STILL in the snapshot (fade window).
  const snap = asyncAgentRegistry.getSnapshot();
  expect(snap.find((a) => a.agentId === "watch-me")).toBeDefined();
  h.unmount();
});

test("viewMode falls back to main on markFailed", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "boom",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const ref = React.createRef<HostHandle>();
  const h = mount(
    React.createElement(Host, {
      ref,
      initialViewMode: { kind: "agent", agentId: "boom" },
    }),
  );
  await settle();
  asyncAgentRegistry.markFailed("boom");
  await settle();
  expect(ref.current?.viewMode.kind).toBe("main");
  h.unmount();
});

test("viewMode stays in agent while it is still running", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "alive",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const ref = React.createRef<HostHandle>();
  const h = mount(
    React.createElement(Host, {
      ref,
      initialViewMode: { kind: "agent", agentId: "alive" },
    }),
  );
  await settle();
  // Add a second agent, modify transcript — fade window unchanged.
  asyncAgentRegistry.appendToTranscript("alive", {
    id: "t1",
    type: "tool_call",
  } as any);
  await settle();
  expect(ref.current?.viewMode.kind).toBe("agent");
  if (ref.current?.viewMode.kind === "agent") {
    expect(ref.current.viewMode.agentId).toBe("alive");
  }
  h.unmount();
});
