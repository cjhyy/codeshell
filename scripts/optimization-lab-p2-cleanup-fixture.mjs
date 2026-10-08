/** Isolated Bun process: construction/cleanup fault injection never alters other test modules. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "bun:test";

const root = mkdtempSync(join(tmpdir(), "codeshell-lab-p2-cleanup-"));
const home = join(root, "home");
const cwd = join(root, "project");
mkdirSync(home);
mkdirSync(cwd);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AGENT_CWD = cwd;
process.env.CODE_SHELL_HOME = join(home, ".code-shell");
process.env.CODE_SHELL_TEST_HOME = process.env.CODE_SHELL_HOME;
globalThis.fetch = async () => {
  throw new Error("Cleanup fixture refuses network access");
};
let phase;
let counts;
let controller;
mock.module(
  fileURLToPath(new URL("../packages/core/dist/protocol/factories.js", import.meta.url)),
  () => ({
    createServer() {
      counts.server++;
      if (phase === "server") throw new Error("fixture server construction failure");
      return {
        async close() {
          counts.serverClose++;
          if (phase === "server_close") throw new Error("fixture server close failure");
        },
        engine: {
          async dispose() {
            counts.engineDispose++;
            if (phase === "engine_dispose") throw new Error("fixture engine dispose failure");
          },
        },
      };
    },
    createClient() {
      counts.client++;
      if (phase === "client") throw new Error("fixture client construction failure");
      if (phase === "construction_abort") controller.abort();
      return {
        async run() {
          counts.run++;
          if (phase === "run_abort") controller.abort();
          throw new Error("fixture run failure");
        },
        async cancel() {
          counts.cancel++;
        },
        close() {
          counts.clientClose++;
          if (phase === "client_close") throw new Error("fixture client close failure");
        },
      };
    },
  }),
);

try {
  const { runIsolatedInstruction } =
    await import("../packages/core/dist/skills/isolated-instruction-run.js");
  const phases = [
    "pre_abort",
    "server",
    "client",
    "construction_abort",
    "run",
    "run_abort",
    "server_close",
    "client_close",
    "engine_dispose",
  ];
  for (phase of phases) {
    counts = {
      server: 0,
      client: 0,
      run: 0,
      cancel: 0,
      serverClose: 0,
      clientClose: 0,
      engineDispose: 0,
    };
    controller = new AbortController();
    if (phase === "pre_abort") controller.abort();
    await assert.rejects(
      runIsolatedInstruction({
        cwd,
        llm: { provider: "openai", model: "fixture", apiKey: "fixture" },
        clientDefaults: {},
        name: "fixture",
        sourceRevision: "a".repeat(64),
        body: "fixed fixture body",
        task: "fixture task",
        signal: controller.signal,
        receiptRoot: join(root, "receipts"),
      }),
    );
    assert.deepEqual(
      counts,
      {
        server: phase === "pre_abort" ? 0 : 1,
        client: ["pre_abort", "server"].includes(phase) ? 0 : 1,
        run: ["pre_abort", "server", "client", "construction_abort"].includes(phase) ? 0 : 1,
        cancel: phase === "run_abort" ? 1 : 0,
        serverClose: ["pre_abort", "server"].includes(phase) ? 0 : 1,
        clientClose: ["pre_abort", "server", "client"].includes(phase) ? 0 : 1,
        engineDispose: ["pre_abort", "server"].includes(phase) ? 0 : 1,
      },
      phase,
    );
  }
  console.log(JSON.stringify({ ok: true, cleanupCases: phases.length, noNetwork: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
