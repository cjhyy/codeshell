import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../scripts/bun-test-completion.mjs";

// Run each scenario in its own process: HTTP/TCP guards must precede Core
// imports without changing the network APIs used by unrelated test files.
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "tests/fixtures/cua-driver-spike.integration.ts");
const scenarios = {
  calculator: "Engine receives permissions and screenshots while clicking 7 + 8 = 15",
  generic: "the generic MCPTool route preserves Cua screenshots through the Engine",
  disabled: "the default-off flag prevents daemon startup and Cua tool execution",
  "disable-active":
    "turning off a running service blocks existing Cua tools and omits them from new sessions",
  delayed: "a delayed daemon is published to the Engine only after its socket is ready",
  cancel: "aborting the Engine cancels a pending Cua observation and releases its proxy",
  restart:
    "the active Engine reobserves after a daemon crash without replaying the interrupted click",
};

for (const [scenario, title] of Object.entries(scenarios)) {
  test.skipIf(process.platform === "win32")(
    title,
    async () => {
      // Keep AF_UNIX paths below macOS's 104-byte limit, even when the user's
      // TMPDIR is a long /var/folders path.
      const directory = mkdtempSync(join("/tmp", "cs-cua-"));
      const env = createBunTestEnvironment(process.env, join(directory, "isolation"));
      const child = spawn(
        process.execPath,
        ["--tsconfig-override", join(root, "tsconfig.json"), fixture, scenario, directory],
        { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const closed = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let completed = false;
      let succeeded = false;
      try {
        const exit = await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Cua fixture deadline\n${stderr}`)), 20_000);
          }),
        ]);
        completed = true;
        expect({ ...exit, stderr: exit.code === 0 ? "" : stderr }).toEqual({
          code: 0,
          signal: null,
          stderr: "",
        });
        const receipt = JSON.parse(readFileSync(join(directory, "completion.json"), "utf8"));
        expect(receipt.scenario).toBe(scenario);
        expect(receipt.unexpectedNetworkCalls).toBe(0);
        expect(receipt.children.every((entry: { alive: boolean }) => !entry.alive)).toBe(true);
        expect(receipt.socketRemoved).toBe(true);
        expect(stdout).toContain("Cua integration completed");
        succeeded = true;
      } finally {
        clearTimeout(timer);
        if (!completed) {
          child.kill("SIGTERM");
          await Promise.race([
            closed.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 2000)),
          ]);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await closed.catch(() => {});
          }
        }
        // The subprocess owns its children; if a deadline interrupted its
        // finally block, reap only fixture PIDs recorded in this private dir.
        if (!succeeded) {
          try {
            for (const line of readFileSync(join(directory, "events.jsonl"), "utf8")
              .trim()
              .split("\n")) {
              const event = JSON.parse(line);
              if (event.phase === "started") {
                try {
                  process.kill(event.pid, "SIGKILL");
                } catch {
                  /* Already reaped. */
                }
              }
            }
          } catch {
            /* No driver was started. */
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
    25_000,
  );
}
