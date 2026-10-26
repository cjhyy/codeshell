import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearModelTracingConfiguration,
  configureModelTracing,
  modelTraceFetch,
  withModelTrace,
} from "./context.js";
import type { ModelTraceStore } from "./store.js";

let directory: string;
let store: ModelTraceStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "codeshell-trace-stream-cancel-"));
  store = configureModelTracing({ storageDir: directory });
});
afterEach(() => {
  clearModelTracingConfiguration();
  rmSync(directory, { recursive: true, force: true });
});

for (const rejectsCancellation of [false, true]) {
  test(`cancelling a pending read retains its terminal state (source cancel rejects: ${rejectsCancellation})`, async () => {
    let notifyPull!: () => void;
    const pulled = new Promise<void>((resolve) => (notifyPull = resolve));
    const source = new ReadableStream<Uint8Array>({
      pull() {
        notifyPull();
        return new Promise<void>(() => {});
      },
      cancel() {
        if (rejectsCancellation) throw new Error("source cancellation failed");
      },
    });
    const observedFetch = modelTraceFetch((async (input) => {
      expect(String(input)).toBe("https://trace.fixture.invalid");
      return new Response(source, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch);

    await withModelTrace(
      { provider: "fixture", model: "fixture" },
      { systemPrompt: "fixture", messages: [], tools: [] },
      async () => {
        const response = await observedFetch("https://trace.fixture.invalid");
        const reader = response.body!.getReader();
        const pending = reader.read();
        await pulled;
        const cancellation = reader.cancel("consumer stopped reading");
        if (rejectsCancellation)
          await expect(cancellation).rejects.toThrow("source cancellation failed");
        else await cancellation;
        expect(await pending).toEqual({ done: true, value: undefined });
        // Let the already-pending pull continuation settle before checking its record.
        await Promise.resolve();
        const [entry] = store.list().items;
        const attempt = store.get(entry.id)!.attempts[0];
        expect(attempt.status).toBe("cancelled");
        expect(attempt.error).toBeUndefined();
        expect(attempt.endedAt).toBeDefined();
        return { text: "consumer continued", toolCalls: [] };
      },
    );
    const [entry] = store.list().items;
    const record = store.get(entry.id)!;
    expect(record.status).toBe("completed");
    expect(record.attempts[0].status).toBe("cancelled");
    expect(record.attempts[0].endedAt!).toBeLessThanOrEqual(record.endedAt!);
  });
}
