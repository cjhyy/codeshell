import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// mock.module replaces Bun's module cache process-wide. Keep Electron doubles in
// a child process so this suite cannot poison other Desktop tests in its shard.
const fixture = fileURLToPath(new URL("./mimi-companion-host.fixture.ts", import.meta.url));

const scenarios = [
  "withdraw-and-late-ready",
  "concurrent-load-failure",
  "close-cleans-listeners",
  "capture-while-human-active",
  "busy-preview-rejects",
  "chat-and-badge-beside-character",
  "handoff-only-across-apps",
  "menu-resize-and-dock-reach-presence",
  "keeps-dock-icon",
] as const;

describe("actual Mimi companion host", () => {
  for (const scenario of scenarios) {
    test(
      scenario,
      async () => {
        const child = Bun.spawn([process.execPath, fixture, scenario], {
          // The guarded runner's isolated HOME and scrubbed credentials must flow
          // through to this process too; no real Electron app or accounts load.
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const timeout = setTimeout(() => child.kill(), 4_000);
        try {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect({ exitCode, stdout, stderr }).toEqual({
            exitCode: 0,
            stdout: `${scenario}: ok\n`,
            stderr: "",
          });
        } finally {
          clearTimeout(timeout);
          child.kill();
        }
      },
      5_000,
    );
  }
});
