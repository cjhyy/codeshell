import { test, expect, beforeEach, afterEach } from "bun:test";
import { osc, OSC, wrapForMultiplexer, getClipboardPath } from "../src/render/termio/osc.js";

// Use `Object.defineProperty` so re-assigning process.platform works.
const ORIG_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
function restorePlatform() {
  Object.defineProperty(process, "platform", { value: ORIG_PLATFORM, configurable: true });
}

const ENV_KEYS = ["TMUX", "STY", "SSH_CONNECTION"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
function clearEnv() {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
}

beforeEach(() => {
  clearEnv();
});
afterEach(() => {
  restoreEnv();
  restorePlatform();
});

test("OSC 52 raw sequence: ESC ] 52 ; c ; <b64> BEL", () => {
  const b64 = Buffer.from("hello", "utf8").toString("base64");
  const seq = osc(OSC.CLIPBOARD, "c", b64);
  expect(seq).toBe(`\x1b]52;c;${b64}\x07`);
});

test("wrapForMultiplexer is a no-op outside tmux/screen", () => {
  const raw = "\x1b]52;c;abc\x07";
  expect(wrapForMultiplexer(raw)).toBe(raw);
});

test("wrapForMultiplexer wraps in tmux DCS passthrough with doubled ESC", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
  const raw = "\x1b]52;c;abc\x07";
  const wrapped = wrapForMultiplexer(raw);
  // Inner ESCs are doubled, wrapped with ESC P tmux ; ... ESC \\
  const expectedInner = "\x1b\x1b]52;c;abc\x07";
  expect(wrapped).toBe(`\x1bPtmux;${expectedInner}\x1b\\`);
});

test("getClipboardPath: native on local macOS, tmux-buffer when TMUX set + SSH, osc52 over SSH no tmux", () => {
  // 1) Local macOS, no SSH, no tmux -> native
  setPlatform("darwin");
  expect(getClipboardPath()).toBe("native");

  // 2) SSH + TMUX -> tmux-buffer (native gated off by SSH_CONNECTION)
  process.env.SSH_CONNECTION = "1.2.3.4 22 5.6.7.8 22";
  process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
  expect(getClipboardPath()).toBe("tmux-buffer");

  // 3) SSH, no tmux -> osc52
  delete process.env.TMUX;
  expect(getClipboardPath()).toBe("osc52");
});
