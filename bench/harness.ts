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
import { renderSync, type Instance } from "../packages/tui/src/render/index.js";

export interface BenchHarness {
  stdin: PassThrough;
  stdout: PassThrough;
  instance: Instance;
  frameCount: number;
  bytesWritten: number;
  writeCount: number;
  waitForFrame: (minimum: number) => Promise<void>;
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

  const frameListeners = new Set<() => void>();
  const h: BenchHarness = {
    stdin,
    stdout,
    instance: null as unknown as Instance,
    frameCount: 0,
    bytesWritten: 0,
    writeCount: 0,
    waitForFrame(minimum) {
      if (h.frameCount >= minimum) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const check = () => {
          if (h.frameCount < minimum) return;
          clearTimeout(timeout);
          frameListeners.delete(check);
          resolve();
        };
        const timeout = setTimeout(() => {
          frameListeners.delete(check);
          reject(new Error(`Renderer did not produce frame ${minimum} within 10 seconds`));
        }, 10_000);
        frameListeners.add(check);
      });
    },
    unmount() {
      h.instance.unmount();
      h.instance.cleanup();
      stdin.destroy();
      stdout.destroy();
    },
  };
  stdout.on("data", (chunk: Buffer) => {
    h.writeCount += 1;
    h.bytesWritten += chunk.byteLength;
  });
  h.instance = renderSync(element, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame() {
      h.frameCount += 1;
      for (const listener of frameListeners) listener();
    },
  });
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
    [pad("label", 30), pad("iters", 8), pad("total ms", 12), pad("per iter ms", 14)].join("") +
      "\n",
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

/** Measure committed updates after warm mount, including the final terminal frame. */
export async function runUpdates(
  label: string,
  steps: number,
  elementAt: (step: number) => React.ReactElement,
): Promise<void> {
  const h = setup(elementAt(0));
  try {
    await h.waitForFrame(1);
    const initialFrames = h.frameCount;
    const initialWrites = h.writeCount;
    const initialBytes = h.bytesWritten;
    let step = 0;
    const timing = await time(label, steps, async () => {
      const nextFrame = h.frameCount + 1;
      h.instance.rerender(elementAt(++step));
      await flush();
      // Earlier updates may batch together. Always include the last painted state.
      if (step === steps) await h.waitForFrame(nextFrame);
    });
    printTable([timing]);
    process.stdout.write(
      `updates=${step}\nbytes_written=${h.bytesWritten - initialBytes}\nframe_count=${h.frameCount - initialFrames}\nwrite_count=${h.writeCount - initialWrites}\n`,
    );
  } finally {
    h.unmount();
  }
}
