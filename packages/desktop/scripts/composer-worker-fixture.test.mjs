import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { observeComposerWorker } from "./composer-worker-fixture.mjs";

test(
  "the held provider releases its real worker turn after collection and Stop",
  { timeout: 5000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "codeshell-composer-provider-"));
    const ledger = join(home, "calls.jsonl");
    const origin = "http://127.0.0.1:1";
    const priorFetch = globalThis.fetch;
    const priorEmit = process.stdin.emit;
    t.after(async () => {
      globalThis.fetch = priorFetch;
      process.stdin.emit = priorEmit;
      await rm(home, { recursive: true, force: true });
    });
    globalThis.fetch = () => {
      throw Error("Unexpected network request");
    };
    observeComposerWorker({ sessionId: "owned", projectPath: home, origin, ledger });
    process.stdin.emit(
      "data",
      JSON.stringify({
        id: "turn",
        method: "agent/run",
        params: { sessionId: "owned", task: "[OWNED_QUEUE_HOLD_test]", cwd: home },
      }) + "\n",
    );
    const controller = new AbortController();
    const stopped = new Error("Stop this turn");
    const pending = fetch(origin + "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
      signal: controller.signal,
    });
    while (!(await readFile(ledger, "utf8")).includes('"provider":"QUEUE_HOLD_test"'))
      await setImmediate();
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc");
    for (let i = 0; i < 4; i++) {
      await setImmediate();
      collect();
    }
    controller.abort(stopped);
    await assert.rejects(pending, (error) => error === stopped);
  },
);
