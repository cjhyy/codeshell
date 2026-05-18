import { test, expect } from "bun:test";
import React, { useState, useImperativeHandle, forwardRef } from "react";
import { mount, flush } from "../render-fixtures";
import { Box, Text, useInput } from "../../src/render/index.js";
import {
  AgentDock,
  getVisibleAgents,
  MAX_VISIBLE,
  type DockViewMode,
} from "../../src/ui/components/AgentDock.js";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";
import { CommandInput } from "../../src/ui/components/CommandInput.js";

/**
 * The keyboard branch lives inline in App.tsx, but the behaviour is small
 * enough to extract into a host fixture: we re-implement the exact branch
 * here and assert against it. This keeps the test from depending on the
 * full App.tsx surface (modals, queryGuard, etc.).
 *
 * If you change the branch in App.tsx, update this fixture in lockstep so
 * the test continues to guard the real shape.
 *
 * State is exposed via an imperative ref instead of rendered probe text —
 * Ink's delta-renderer only writes the changed cells (using cursor
 * positioning escapes), so substring-matching the frame buffer is too
 * brittle. The ref captures the exact value `useInput` sets.
 */
export interface DockHostHandle {
  getState(): {
    viewMode: DockViewMode;
    dockFocusIdx: number | null;
    cancelledCount: number;
  };
}

const DockHost = forwardRef<
  DockHostHandle,
  {
    initialViewMode?: DockViewMode;
    onCancel?: () => void;
  }
>(function DockHost({ initialViewMode = { kind: "main" }, onCancel }, ref) {
  const [viewMode, setViewMode] = useState<DockViewMode>(initialViewMode);
  const [dockFocusIdx, setDockFocusIdx] = useState<number | null>(null);
  const [inputValue] = useState("");
  const [cancelledCount, setCancelledCount] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      getState: () => ({ viewMode, dockFocusIdx, cancelledCount }),
    }),
    [viewMode, dockFocusIdx, cancelledCount],
  );

  useInput((_ch, key) => {
    if (dockFocusIdx !== null) {
      const visible = getVisibleAgents(
        asyncAgentRegistry.getSnapshot(),
        Date.now(),
      );
      // 0 = main row, 1..agentRows = agents.
      const agentRows = Math.min(MAX_VISIBLE, visible.length);
      const maxIdx = agentRows;

      if (key.upArrow) {
        if (dockFocusIdx === 0) setDockFocusIdx(null);
        else setDockFocusIdx(dockFocusIdx - 1);
        return;
      }
      if (key.downArrow) {
        setDockFocusIdx(Math.min(maxIdx, dockFocusIdx + 1));
        return;
      }
      if (key.return) {
        if (dockFocusIdx === 0) {
          setViewMode({ kind: "main" });
        } else {
          const target = visible[dockFocusIdx - 1];
          if (target) setViewMode({ kind: "agent", agentId: target.agentId });
        }
        setDockFocusIdx(null);
        return;
      }
      if (key.escape) {
        setDockFocusIdx(null);
        return;
      }
    }

    if (key.escape && viewMode.kind === "agent") {
      setViewMode({ kind: "main" });
      return;
    }

    if (key.escape) {
      setCancelledCount((c) => c + 1);
      onCancel?.();
    }

    if (key.downArrow && dockFocusIdx === null && inputValue === "") {
      const visible = getVisibleAgents(
        asyncAgentRegistry.getSnapshot(),
        Date.now(),
      );
      if (visible.length > 0) setDockFocusIdx(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text>host</Text>
      </Box>
      <AgentDock viewMode={viewMode} focusedIndex={dockFocusIdx} />
    </Box>
  );
});

function reset() {
  asyncAgentRegistry.reset();
}

function send(h: { stdin: NodeJS.WritableStream }, bytes: string) {
  h.stdin.write(bytes);
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

// Wait twice — once for the React state commit triggered by the input
// event, and again so any effects scheduled by that commit can run before
// the test inspects the ref.
async function settle() {
  await flush();
  await flush();
}

// A lone ESC byte is ambiguous (could be the start of a CSI sequence), so
// the renderer's input parser buffers it for NORMAL_TIMEOUT (50ms) before
// flushing it as a standalone Escape key. Wait past that window before
// asserting any Esc-triggered state.
async function settleEsc() {
  await new Promise((r) => setTimeout(r, 80));
  await flush();
  await flush();
}

test("↓ on empty input with 2 agents → dockFocusIdx becomes 0", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1", description: "first", status: "running",
    startedAt: Date.now(), abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2", description: "second", status: "running",
    startedAt: Date.now(), abort: () => {},
  });
  const ref = React.createRef<DockHostHandle>();
  const h = mount(React.createElement(DockHost, { ref }), { columns: 80 });
  await settle();
  send(h, DOWN);
  await settle();
  expect(ref.current?.getState().dockFocusIdx).toBe(0);
  h.unmount();
});

test("dockFocusIdx 0 + ↑ → returns to null", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1", description: "first", status: "running",
    startedAt: Date.now(), abort: () => {},
  });
  const ref = React.createRef<DockHostHandle>();
  const h = mount(React.createElement(DockHost, { ref }), { columns: 80 });
  await settle();
  send(h, DOWN);
  await settle();
  send(h, UP);
  await settle();
  expect(ref.current?.getState().dockFocusIdx).toBe(null);
  h.unmount();
});

test("dockFocusIdx 0 + ↓ → advances, clamped at agentRows", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1", description: "first", status: "running",
    startedAt: Date.now(), abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2", description: "second", status: "running",
    startedAt: Date.now(), abort: () => {},
  });
  const ref = React.createRef<DockHostHandle>();
  const h = mount(React.createElement(DockHost, { ref }), { columns: 80 });
  await settle();
  // null → 0 (main) → 1 (a1) → 2 (a2), clamped at 2.
  send(h, DOWN);
  await settle();
  send(h, DOWN);
  await settle();
  send(h, DOWN);
  await settle();
  expect(ref.current?.getState().dockFocusIdx).toBe(2);
  h.unmount();
});

test("dockFocusIdx 1 + Enter → setViewMode agent, focus released", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "the-target", description: "first", status: "running",
    startedAt: Date.now(), abort: () => {},
  });
  const ref = React.createRef<DockHostHandle>();
  const h = mount(React.createElement(DockHost, { ref }), { columns: 80 });
  await settle();
  // null → 0 (main) → 1 (the-target), then ENTER activates the agent.
  send(h, DOWN);
  await settle();
  send(h, DOWN);
  await settle();
  send(h, ENTER);
  await settle();
  const s = ref.current?.getState();
  expect(s?.dockFocusIdx).toBe(null);
  expect(s?.viewMode).toEqual({ kind: "agent", agentId: "the-target" });
  h.unmount();
});

test("dockFocusIdx + Esc → focus released, no cancel call", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1", description: "first", status: "running",
    startedAt: Date.now(), abort: () => {},
  });
  let cancelled = false;
  const ref = React.createRef<DockHostHandle>();
  const h = mount(
    React.createElement(DockHost, { ref, onCancel: () => (cancelled = true) }),
    { columns: 80 },
  );
  await settle();
  send(h, DOWN);
  await settle();
  send(h, ESC);
  await settleEsc();
  expect(ref.current?.getState().dockFocusIdx).toBe(null);
  expect(cancelled).toBe(false);
  h.unmount();
});

test("viewMode=agent + Esc → returns to main, no cancel call", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "the-target", description: "first", status: "running",
    startedAt: Date.now(), abort: () => {},
  });
  let cancelled = false;
  const ref = React.createRef<DockHostHandle>();
  const h = mount(
    React.createElement(DockHost, {
      ref,
      initialViewMode: { kind: "agent", agentId: "the-target" },
      onCancel: () => (cancelled = true),
    }),
    { columns: 80 },
  );
  await settle();
  send(h, ESC);
  await settleEsc();
  expect(ref.current?.getState().viewMode).toEqual({ kind: "main" });
  expect(cancelled).toBe(false);
  h.unmount();
});

test("viewMode=main + Esc with no dock focus → cancel branch fires", async () => {
  reset();
  let cancelled = false;
  const ref = React.createRef<DockHostHandle>();
  const h = mount(
    React.createElement(DockHost, { ref, onCancel: () => (cancelled = true) }),
    { columns: 80 },
  );
  await settle();
  send(h, ESC);
  await settleEsc();
  expect(cancelled).toBe(true);
  h.unmount();
});

test("disabled CommandInput swallows all keys", async () => {
  let changed = 0;
  let submitted = 0;
  const h = mount(
    React.createElement(CommandInput, {
      value: "",
      onChange: () => {
        changed += 1;
      },
      onSubmit: () => {
        submitted += 1;
      },
      commands: [],
      disabled: true,
    }),
    { columns: 80 },
  );
  await flush();
  // Send a few keys: up arrow, down arrow, a letter, Enter.
  h.stdin.write(UP);
  await flush();
  h.stdin.write(DOWN);
  await flush();
  h.stdin.write("x");
  await flush();
  h.stdin.write(ENTER);
  await flush();
  expect(changed).toBe(0);
  expect(submitted).toBe(0);
  h.unmount();
});

test("↓ from input with 2 agents → dockFocusIdx 0 (main row)", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1", description: "first", status: "running",
    startedAt: 10, abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2", description: "second", status: "running",
    startedAt: 20, abort: () => {},
  });
  const ref = React.createRef<DockHostHandle>();
  const h = mount(React.createElement(DockHost, { ref }), { columns: 80 });
  await settle();
  send(h, DOWN);
  await settle();
  expect(ref.current?.getState().dockFocusIdx).toBe(0);
  h.unmount();
});

test("dockFocusIdx 0 + Enter → setViewMode main, focus released", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1", description: "first", status: "running",
    startedAt: 10, abort: () => {},
  });
  const ref = React.createRef<DockHostHandle>();
  const h = mount(
    React.createElement(DockHost, {
      ref,
      initialViewMode: { kind: "agent", agentId: "a1" },
    }),
    { columns: 80 },
  );
  await settle();
  send(h, DOWN); // null → 0 (main row)
  await settle();
  send(h, ENTER);
  await settle();
  const s = ref.current?.getState();
  expect(s?.dockFocusIdx).toBe(null);
  expect(s?.viewMode.kind).toBe("main");
  h.unmount();
});

test("dockFocusIdx N (last agent) + ↓ → still N", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1", description: "first", status: "running",
    startedAt: 10, abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2", description: "second", status: "running",
    startedAt: 20, abort: () => {},
  });
  const ref = React.createRef<DockHostHandle>();
  const h = mount(React.createElement(DockHost, { ref }), { columns: 80 });
  await settle();
  // null → 0 (main) → 1 (a1) → 2 (a2) → 2 (clamped).
  for (let i = 0; i < 4; i++) {
    send(h, DOWN);
    await settle();
  }
  expect(ref.current?.getState().dockFocusIdx).toBe(2);
  h.unmount();
});

test("focus does not advance past MAX_VISIBLE when there are more agents", async () => {
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
  const ref = React.createRef<DockHostHandle>();
  const h = mount(React.createElement(DockHost, { ref }), { columns: 200 });
  await settle();
  // ↓ 8 times: null→0 (main), 0→1→2→3→4→5 (five agent rows), then clamped at 5.
  for (let i = 0; i < 8; i++) {
    send(h, DOWN);
    await settle();
  }
  expect(ref.current?.getState().dockFocusIdx).toBe(5);
  h.unmount();
});
