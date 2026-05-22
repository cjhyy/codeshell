import { test, expect } from "bun:test";
import React from "react";
import { Text, useInput } from "../packages/tui/src/render/index.js";
import type { InputEvent } from "../packages/tui/src/render/events/input-event.js";
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
  // Fixture: ESC[97;6u = Ctrl+Shift+A in kitty CSI-u format.
  // Modifier 6 = 1 + shift(1) + ctrl(4); codepoint 97 = 'a' → input='a'.
  const events: Array<{ input: string; key: Record<string, unknown> }> = [];
  const h = mount(
    React.createElement(Probe, { onKey: (input, key) => events.push({ input, key }) }),
  );
  await flush();
  h.stdin.write(loadFixture("keypress", "kitty.txt"));
  await flush();
  // The parser must decode modifier 6 → ctrl=true, shift=true; codepoint 97 → input='a'.
  expect(
    events.some((e) => e.key.ctrl === true && e.key.shift === true && e.input === "a"),
  ).toBe(true);
  h.unmount();
});

test("modifyOtherKeys sequence parses without crashing", async () => {
  // Fixture: ESC[27;6;65~ = Ctrl+Shift+A in modifyOtherKeys mode 2.
  // Modifier 6 = 1 + shift(1) + ctrl(4); keycode 65 = 'A' → name='a' → input='a'.
  const events: Array<{ input: string; key: Record<string, unknown> }> = [];
  const h = mount(
    React.createElement(Probe, { onKey: (input, key) => events.push({ input, key }) }),
  );
  await flush();
  h.stdin.write(loadFixture("keypress", "modify-other-keys.txt"));
  await flush();
  // The parser must decode modifier 6 → ctrl=true, shift=true; keycode 65 → input='a'.
  expect(
    events.some((e) => e.key.ctrl === true && e.key.shift === true && e.input === "a"),
  ).toBe(true);
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
  // The renderer must have produced at least one frame (initial render).
  // A crash would leave frames empty or throw during dumpFrames.
  expect(h.frames.length).toBeGreaterThan(0);
  h.unmount();
});
