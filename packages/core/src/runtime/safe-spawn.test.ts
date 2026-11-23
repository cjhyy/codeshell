import { describe, expect, test } from "bun:test";
import { mkdtemp, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { safeSpawn } from "./safe-spawn.js";
import { groupAlive } from "./spawn-common.js";

describe("safeSpawn process groups", () => {
  test("timeout reaps helpers spawned by a direct command", async () => {
    if (process.platform === "win32") return;

    const result = await safeSpawn("/bin/sh", ["-c", "echo $$; sleep 30 & wait"], {
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 100,
      processGroup: true,
    });

    expect(result.reason).toBe("timeout");
    const processGroupId = Number(result.stdout.trim().split(/\s+/)[0]);
    expect(processGroupId).toBeGreaterThan(1);
    expect(groupAlive(processGroupId)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "abort waits for a helper with closed stdio that ignores SIGTERM",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "owned-spawn-group-"));
      const controller = new AbortController();
      const running = safeSpawn(
        "/bin/sh",
        [
          "-c",
          'echo $$; (trap "" TERM; touch ready; exec sleep 30) </dev/null >/dev/null 2>&1 & wait',
        ],
        {
          cwd: root,
          env: process.env,
          timeoutMs: 5000,
          signal: controller.signal,
          processGroup: true,
        },
      );
      try {
        const deadline = Date.now() + 3000;
        while (
          !(await access(join(root, "ready")).then(
            () => true,
            () => false,
          ))
        ) {
          if (Date.now() > deadline) throw Error("The owned helper did not start");
          await delay(10);
        }
        controller.abort();
        const result = await running;
        expect(result.reason).toBe("aborted");
        const pgid = Number(result.stdout.trim());
        expect(pgid).toBeGreaterThan(1);
        expect(groupAlive(pgid)).toBe(false);
      } finally {
        controller.abort();
        await running;
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
