import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { renderSync, type Instance } from "../src/render/index.js";

const FIXTURE_ROOT = join(__dirname, "fixtures", "render");

/**
 * Load a `.txt` fixture file. Lines starting with `#` are comments. All
 * remaining non-empty lines are JSON-decoded as quoted strings and
 * concatenated. ESC bytes are stored as `` escapes in the fixture
 * (raw 0x1b is illegal in JSON string literals).
 */
export function loadFixture(...parts: string[]): string {
  const raw = readFileSync(join(FIXTURE_ROOT, ...parts), "utf8");
  let out = "";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    out += JSON.parse(trimmed);
  }
  return out;
}

export interface TestHarness {
  stdin: PassThrough;
  stdout: PassThrough;
  frames: string[];
  instance: Instance;
  unmount: () => void;
}

/**
 * Mount a component into an isolated render root with piped stdin/stdout.
 * Each write to stdout is captured as a separate frame entry.
 */
export function mount(
  element: React.ReactElement,
  opts: { columns?: number; rows?: number } = {},
): TestHarness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  // App.tsx calls stdin.setRawMode(), stdin.ref(), and stdin.unref() when
  // isTTY is true. PassThrough lacks these TTY methods, so add no-op stubs
  // so that useInput hooks work in tests without throwing "not a function".
  (stdin as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  (stdout as unknown as { isTTY: boolean; columns: number; rows: number }).isTTY = true;
  (stdout as unknown as { columns: number }).columns = opts.columns ?? 80;
  (stdout as unknown as { rows: number }).rows = opts.rows ?? 24;

  const frames: string[] = [];
  stdout.on("data", (chunk: Buffer) => frames.push(chunk.toString("utf8")));

  const instance = renderSync(element, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    stdin,
    stdout,
    frames,
    instance,
    unmount: () => instance.unmount(),
  };
}

/** Concatenate all frames written so far. */
export function dumpFrames(h: TestHarness): string {
  return h.frames.join("");
}

/** Wait for the next macrotask so the renderer can flush. */
export function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
