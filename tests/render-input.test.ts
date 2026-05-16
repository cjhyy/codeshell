import { test, expect } from "bun:test";
import React from "react";
import { Text, useInput } from "../src/render/index.js";
import type { InputEvent } from "../src/render/events/input-event.js";
import { mount, flush, loadFixture, dumpFrames } from "./render-fixtures";

function Probe({ onKey }: { onKey: (input: string, key: Record<string, unknown>) => void }) {
  useInput((input, key) => onKey(input, key as unknown as Record<string, unknown>));
  return React.createElement(Text, null, "ready");
}

test("plain ASCII key reaches useInput", async () => {
  const events: Array<{ input: string }> = [];
  const h = mount(React.createElement(Probe, { onKey: (input) => events.push({ input }) }));
  await flush();
  h.stdin.write(loadFixture("keypress", "plain.txt"));
  await flush();
  expect(events.some((e) => e.input === "a")).toBe(true);
  h.unmount();
});

test("Ctrl/Meta combos parse correctly", async () => {
  const seen: Array<{ input: string; ctrl?: boolean; meta?: boolean }> = [];
  const h = mount(
    React.createElement(Probe, {
      onKey: (input, key) =>
        seen.push({ input, ctrl: Boolean(key.ctrl), meta: Boolean(key.meta) }),
    }),
  );
  await flush();
  h.stdin.write(loadFixture("keypress", "ctrl-meta.txt"));
  await flush();
  // Ctrl+A should produce a ctrl event
  expect(seen.some((e) => e.ctrl && e.input.toLowerCase() === "a")).toBe(true);
  // Meta+E should produce a meta event (Meta+B is overridden as Alt+Left by iTerm rule)
  expect(seen.some((e) => e.meta && e.input.toLowerCase() === "e")).toBe(true);
  h.unmount();
});

test("bracketed paste delivers the inner payload", async () => {
  const captured: string[] = [];
  function PasteProbe() {
    useInput((input, _key, event) => {
      // isPasted lives on event.keypress (ParsedKey), not on Key
      const ev = event as unknown as InputEvent;
      if (ev.keypress.isPasted) captured.push(input);
    });
    return React.createElement(Text, null, "ready");
  }
  const h = mount(React.createElement(PasteProbe));
  await flush();
  h.stdin.write(loadFixture("keypress", "bracketed-paste.txt"));
  await flush();
  expect(captured.join("")).toContain("hi");
  expect(captured.join("")).toContain("there");
  h.unmount();
});

test("kitty keyboard protocol sequence is parsed (does not crash)", async () => {
  const events: unknown[] = [];
  const h = mount(
    React.createElement(Probe, { onKey: (_input, key) => events.push(key) }),
  );
  await flush();
  h.stdin.write(loadFixture("keypress", "kitty.txt"));
  await flush();
  expect(events.length).toBeGreaterThan(0);
  h.unmount();
});

test("modifyOtherKeys sequence parses without crashing", async () => {
  const events: unknown[] = [];
  const h = mount(
    React.createElement(Probe, { onKey: (_input, key) => events.push(key) }),
  );
  await flush();
  h.stdin.write(loadFixture("keypress", "modify-other-keys.txt"));
  await flush();
  expect(events.length).toBeGreaterThan(0);
  h.unmount();
});

test("mouse wheel input does not crash the renderer", async () => {
  function WheelProbe() {
    useInput(() => {});
    return React.createElement(Text, null, "ready");
  }
  const h = mount(React.createElement(WheelProbe));
  await flush();
  h.stdin.write(loadFixture("keypress", "mouse-wheel.txt"));
  await flush();
  expect(() => dumpFrames(h)).not.toThrow();
  h.unmount();
});
