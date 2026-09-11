import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexLaunchResolver } from "./external-runtime-launch.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-launch-"));
  dirs.push(dir);
  return dir;
}
function installCodex(dir: string): string {
  const command = join(dir, "codex");
  writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return command;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Codex launch preparation", () => {
  test("pins the resolved executable and environment without refreshing a healthy PATH", async () => {
    const dir = tempDir();
    const command = installCodex(dir);
    const env = { PATH: dir, NO_PROXY: "example.test" };
    let refreshes = 0;
    const prepare = createCodexLaunchResolver({
      env,
      refreshEnvironment: async () => {
        refreshes++;
      },
    });
    const launch = await prepare(dir);
    env.PATH = "/changed-after-preflight";
    expect(launch).toEqual({ command, env: { PATH: dir, NO_PROXY: "example.test" } });
    expect(refreshes).toBe(0);
  });

  test("recovers a custom install directory through one shared environment refresh", async () => {
    const cwd = tempDir();
    const bin = tempDir();
    const command = installCodex(bin);
    const env = { PATH: cwd };
    let refreshes = 0;
    let release!: () => void;
    let announceRefresh!: () => void;
    const started = new Promise<void>((resolve) => {
      announceRefresh = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = createCodexLaunchResolver({
      env,
      refreshEnvironment: async () => {
        refreshes++;
        announceRefresh();
        await gate;
        env.PATH = bin;
      },
    });
    const first = prepare(cwd);
    const second = prepare(cwd);
    await started;
    release();
    const launches = await Promise.all([first, second]);
    expect(refreshes).toBe(1);
    expect(launches.map((launch) => launch.command)).toEqual([command, command]);
    expect(launches.map((launch) => launch.env.PATH)).toEqual([bin, bin]);
  });

  test("missing programs fail clearly, throttle retries, and detect a later installation", async () => {
    const dir = tempDir();
    let time = 100_000;
    let refreshes = 0;
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const prepare = createCodexLaunchResolver({
      env: { PATH: dir, SECRET_TEST_TOKEN: "must-not-be-logged" },
      now: () => time,
      refreshEnvironment: async () => {
        refreshes++;
      },
      log: (event, data) => logs.push({ event, data }),
    });
    await expect(prepare(dir)).rejects.toThrow(/Codex CLI was not found.*codex --version/);
    await expect(prepare(dir)).rejects.toThrow(/No agent turn was started/);
    expect(refreshes).toBe(1);
    time += 30_001;
    await expect(prepare(dir)).rejects.toThrow(/Codex CLI was not found/);
    expect(refreshes).toBe(2);
    const command = installCodex(dir);
    expect((await prepare(dir)).command).toBe(command);
    expect(refreshes).toBe(2);
    expect(JSON.stringify(logs)).not.toContain("must-not-be-logged");
    expect(JSON.stringify(logs)).not.toContain(dir);
  });

  test("an unexpected refresh failure retains actionable context without dumping shell output", async () => {
    const dir = tempDir();
    const logs: unknown[] = [];
    const prepare = createCodexLaunchResolver({
      env: { PATH: dir },
      refreshEnvironment: async () => {
        throw new Error("private shell output");
      },
      log: (event, data) => logs.push({ event, data }),
    });
    await expect(prepare(dir)).rejects.toThrow(/Codex CLI was not found/);
    expect(JSON.stringify(logs)).not.toContain("private shell output");
  });

  test("distinguishes missing and non-directory cwd before trying to recover PATH", async () => {
    const dir = tempDir();
    const file = installCodex(dir);
    let refreshes = 0;
    const prepare = createCodexLaunchResolver({
      env: { PATH: "" },
      refreshEnvironment: async () => {
        refreshes++;
      },
    });
    await expect(prepare(join(dir, "missing"))).rejects.toThrow(/working directory.*ENOENT/);
    await expect(prepare(file)).rejects.toThrow(/working directory.*ENOTDIR/);
    expect(refreshes).toBe(0);
  });

  test.skipIf(process.platform === "win32")(
    "does not launch a non-executable Codex file",
    async () => {
      const dir = tempDir();
      chmodSync(installCodex(dir), 0o644);
      const prepare = createCodexLaunchResolver({
        env: { PATH: dir },
        refreshEnvironment: async () => {},
      });
      await expect(prepare(dir)).rejects.toThrow(/Codex CLI was not found/);
    },
  );
});
