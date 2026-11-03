import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReadOnlyGitRunner } from "./readonly-git.js";

test("bounds each Git call by the remaining total deadline and removes every inherited Git override", async () => {
  const old = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor=evil'";
  try {
    const timeouts: number[] = [];
    const run = createReadOnlyGitRunner({
      deadline: performance.now() + 80.5,
      execute: async (_cwd, args, options) => {
        expect(args.slice(0, 2)).toEqual(["--no-optional-locks", "--literal-pathspecs"]);
        expect(options.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
        expect(options.env.GIT_ALLOW_PROTOCOL).toBe("");
        expect(options.env.GIT_OPTIONAL_LOCKS).toBe("0");
        expect(Number.isInteger(options.timeout)).toBe(true);
        timeouts.push(options.timeout);
        await new Promise((r) => setTimeout(r, 15));
        return "fixture";
      },
    });
    await run("/fixture", ["rev-parse", "HEAD"]);
    await run("/fixture", ["ls-tree", "HEAD", "--", ":(glob)*"]);
    expect(timeouts[1]!).toBeLessThan(timeouts[0]!);
    await expect(
      createReadOnlyGitRunner({ deadline: performance.now() - 1 })("/fixture", ["status"]),
    ).rejects.toThrow("deadline");
  } finally {
    if (old === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = old;
  }
});

test("execFile really kills a stalled command and bounds captured stdout", async () => {
  if (process.platform === "win32") return;
  const bin = await mkdtemp(join(tmpdir(), "git-fixture-bin-"));
  const old = process.env.PATH;
  const path = join(bin, "git");
  try {
    await writeFile(
      path,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    );
    await chmod(path, 0o755);
    process.env.PATH = `${bin}:${old ?? ""}`;
    const start = performance.now();
    await expect(
      createReadOnlyGitRunner({ deadline: start + 500, commandTimeoutMs: 40 })(bin, ["rev-parse"]),
    ).rejects.toThrow();
    expect(performance.now() - start).toBeLessThan(900);
    await writeFile(path, "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(10000));\n");
    await expect(
      createReadOnlyGitRunner({ deadline: performance.now() + 1000 })(bin, ["cat-file"], 32),
    ).rejects.toThrow();
  } finally {
    if (old === undefined) delete process.env.PATH;
    else process.env.PATH = old;
    await rm(bin, { recursive: true, force: true });
  }
});
