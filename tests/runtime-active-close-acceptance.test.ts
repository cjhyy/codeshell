import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The fixture changes Bun's built-in HTTP exports to deny all traffic. Keep it
// in its own guarded process so it cannot affect other files in a unit shard.
test("actual Engine active-close persistence acceptance in a private guarded process", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(
    "node",
    [
      "scripts/run-bun-test-shard.mjs",
      "--timeout",
      "5000",
      "./tests/fixtures/runtime-active-close-acceptance.fixture.ts",
    ],
    {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let finished = false;
  const completed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        finished = true;
        resolve({ code, signal });
      });
    },
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Active-close fixture exceeded its 20s total deadline")),
          20_000,
        );
      }),
    ]);
    expect(result).toEqual({ code: 0, signal: null });
    expect(output).toContain("Completed Bun shard: 21 tests, 0 skipped; 0 failures.");
  } finally {
    clearTimeout(deadline);
    if (!finished && child.pid) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          env: process.env,
          stdio: "ignore",
          timeout: 3_000,
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Own child group already exited. */
        }
      }
      await Promise.race([
        completed.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    console.log(output);
  }
}, 30_000);
