import { describe, expect, test } from "bun:test";
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(groupAlive(processGroupId)).toBe(false);
  });
});
