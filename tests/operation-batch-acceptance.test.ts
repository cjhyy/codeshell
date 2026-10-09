import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test.each(["operation-batch-acceptance", "operation-batch-ingress"])(
  "%s runs in a fresh guarded process",
  async (fixture) => {
    const child = spawn(
      "node",
      [
        "scripts/run-bun-test-shard.mjs",
        "--timeout",
        "5000",
        "--tsconfig-override",
        "./tests/fixtures/operation-batch-tsconfig.json",
        `./tests/fixtures/${fixture}.fixture.ts`,
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const completed = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(
        await Promise.race([
          completed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Batch fixture total deadline exceeded")),
              25000,
            );
          }),
        ]),
      ).toEqual({ code: 0, signal: null });
      expect(output).toMatch(/Completed Bun shard: \d+ tests, 0 skipped; 0 failures\./);
    } finally {
      clearTimeout(timer);
      // Only signal the still-live owned handle/group; never seed from a historical PID.
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        } else child.kill("SIGKILL");
        await completed.catch(() => {});
      }
      console.log(output);
    }
  },
  30000,
);
