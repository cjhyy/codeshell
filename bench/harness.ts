/**
 * Shared bench harness: mount a React element to a fake terminal, run a
 * scenario function, return frame timing stats.
 *
 * Render benches mount React trees against a piped stdout — they measure
 * how much the renderer writes and how long it takes (not real terminal
 * repaint latency). Use for catching regressions via relative deltas.
 */
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import React from "react";
import { renderSync, type Instance } from "../src/render/index.js";

export interface BenchHarness {
  stdin: PassThrough;
  stdout: PassThrough;
  instance: Instance;
  frameCount: number;
  bytesWritten: number;
  unmount: () => void;
}

export function setup(
  element: React.ReactElement,
  opts: { columns?: number; rows?: number } = {},
): BenchHarness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  // PassThrough lacks setRawMode/ref/unref — stub them so renderer's
  // raw-mode toggling no-ops cleanly under test/bench.
  (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  (stdout as unknown as { isTTY: boolean; columns: number; rows: number }).isTTY = true;
  (stdout as unknown as { columns: number }).columns = opts.columns ?? 120;
  (stdout as unknown as { rows: number }).rows = opts.rows ?? 40;

  const h: BenchHarness = {
    stdin,
    stdout,
    instance: null as unknown as Instance,
    frameCount: 0,
    bytesWritten: 0,
    unmount: () => h.instance.unmount(),
  };
  stdout.on("data", (chunk: Buffer) => {
    h.frameCount += 1;
    h.bytesWritten += chunk.byteLength;
  });
  h.instance = renderSync(element, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  } as unknown as Parameters<typeof renderSync>[1]);
  return h;
}

export async function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export interface Timing {
  label: string;
  totalMs: number;
  iterations: number;
  perIterMs: number;
}

export async function time(
  label: string,
  iterations: number,
  fn: () => void | Promise<void>,
): Promise<Timing> {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  await flush();
  const totalMs = performance.now() - start;
  return {
    label,
    totalMs,
    iterations,
    perIterMs: totalMs / iterations,
  };
}

export function printTable(rows: Timing[]): void {
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  process.stdout.write(
    [
      pad("label", 30),
      pad("iters", 8),
      pad("total ms", 12),
      pad("per iter ms", 14),
    ].join("") + "\n",
  );
  for (const r of rows) {
    process.stdout.write(
      [
        pad(r.label, 30),
        pad(String(r.iterations), 8),
        pad(r.totalMs.toFixed(2), 12),
        pad(r.perIterMs.toFixed(3), 14),
      ].join("") + "\n",
    );
  }
}
