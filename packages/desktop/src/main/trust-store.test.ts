import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  __setTrustFileForTest,
  getTrust,
  getTrustCachedSync,
  setTrust,
  warmTrustCache,
} from "./trust-store.js";

describe("trust-store", () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codeshell-trust-store-"));
    file = join(root, "desktop", "trust.json");
    __setTrustFileForTest(file);
  });

  afterEach(async () => {
    __setTrustFileForTest(null);
    await rm(root, { recursive: true, force: true });
  });

  test("serializes concurrent writes, persists privately, and tightens rewrites", async () => {
    const paths = Array.from({ length: 32 }, (_, index) => join(root, `project-${index}`));
    await Promise.all(paths.map((projectPath) => setTrust(projectPath, "trusted")));

    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
    expect(Object.keys(parsed)).toHaveLength(paths.length);
    expect(paths.every((projectPath) => parsed[projectPath] === "trusted")).toBe(true);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    if (process.platform !== "win32") await chmod(file, 0o644);
    await setTrust(paths[0]!, "untrusted");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("serializes writes across separate desktop processes", async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "trust-store.ts")).href;
    const paths = Array.from({ length: 16 }, (_, index) => join(root, `child-project-${index}`));
    const children = paths.map((projectPath) =>
      Bun.spawn({
        cmd: [
          process.execPath,
          "--eval",
          `import { __setTrustFileForTest, setTrust } from ${JSON.stringify(moduleUrl)};
           __setTrustFileForTest(${JSON.stringify(file)});
           await setTrust(${JSON.stringify(projectPath)}, "trusted");`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const exits = await Promise.all(children.map((child) => child.exited));
    expect(exits).toEqual(Array.from({ length: children.length }, () => 0));

    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
    expect(paths.every((projectPath) => parsed[projectPath] === "trusted")).toBe(true);
  });

  test("trust and catalog mutations sharing the desktop directory cannot steal their own lock", async () => {
    const trustUrl = pathToFileURL(join(import.meta.dir, "trust-store.ts")).href;
    const catalogUrl = pathToFileURL(join(import.meta.dir, "session-catalog-store.ts")).href;
    const corePackage = join(import.meta.dir, "../../../core/package.json");
    // Run the actual stores in an isolated process so a regressed orphaned
    // heartbeat cannot contaminate the surrounding test runner.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--eval",
        `
        import { createRequire } from "node:module";
        import { setImmediate as immediate } from "node:timers/promises";
        import { __setTrustFileForTest, setTrust } from ${JSON.stringify(trustUrl)};
        import { SessionCatalogStore } from ${JSON.stringify(catalogUrl)};
        const { getLocks } = createRequire(${JSON.stringify(corePackage)})("proper-lockfile/lib/lockfile");
        __setTrustFileForTest(${JSON.stringify(file)});
        const errors = [];
        process.on("uncaughtException", error => errors.push({ message: error.message, code: error.code }));
        let completed = false;
        const pending = setTrust(${JSON.stringify(root)}, "untrusted")
          .catch(error => errors.push({ message: error.message, code: error.code }))
          .finally(() => { completed = true; });
        const until = Date.now() + 2000;
        let observedAsyncHolder = false;
        while (!completed && Date.now() < until) {
          if (Object.keys(getLocks()).some(key => key.endsWith(${JSON.stringify(root.split("/").at(-1) + "/desktop")}))) {
            observedAsyncHolder = true;
            break;
          }
          await immediate();
        }
        const started = Date.now();
        const catalog = new SessionCatalogStore({ file: ${JSON.stringify(join(root, "desktop", "session-catalog.json"))} });
        await catalog.apply({ projectKey: "fixture", upserts: [{ id: "s1", values: { title: "saved", createdAt: 1, updatedAt: 1 } }] });
        await pending;
        await new Promise(resolve => setTimeout(resolve, 25));
        console.log(JSON.stringify({ observedAsyncHolder, durationMs: Date.now() - started, errors }));
      `,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(output.trim());
    expect(result.errors).toEqual([]);
    expect(result.observedAsyncHolder).toBe(false);
    expect(result.durationMs).toBeLessThan(2000);
    expect(JSON.parse(await readFile(file, "utf8"))[await realpath(root)]).toBe("untrusted");
    expect(
      JSON.parse(await readFile(join(root, "desktop", "session-catalog.json"), "utf8")).indices
        .fixture.sessions[0].title,
    ).toBe("saved");
  }, 20_000);

  test("clears a previously trusted sync cache when disk becomes corrupt", async () => {
    const projectPath = join(root, "project");
    await setTrust(projectPath, "trusted");
    expect(getTrustCachedSync(projectPath)).toBe("trusted");

    await writeFile(file, "{", "utf8");
    await warmTrustCache();
    expect(getTrustCachedSync(projectPath)).toBe("unknown");
    expect(await getTrust(projectPath)).toBe("unknown");
  });

  test("a mutation recovers a corrupt registry without retaining stale trusted entries", async () => {
    const stale = join(root, "stale-project");
    const current = join(root, "current-project");
    await setTrust(stale, "trusted");
    await writeFile(file, "{", "utf8");
    await setTrust(current, "untrusted");
    expect(getTrustCachedSync(stale)).toBe("unknown");
    expect(getTrustCachedSync(current)).toBe("untrusted");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ [current]: "untrusted" });
  });

  test("uses one canonical trust decision for real and symlink paths", async () => {
    if (process.platform === "win32") return;
    const projectPath = join(root, "project");
    const alias = join(root, "alias");
    await mkdir(projectPath);
    await symlink(projectPath, alias, "dir");

    await setTrust(alias, "trusted");
    expect(await getTrust(projectPath)).toBe("trusted");
    expect(getTrustCachedSync(alias)).toBe("trusted");
  });

  test("does not publish a trust change when durable save fails", async () => {
    const durable = join(root, "durable-project");
    const rejected = join(root, "rejected-project");
    await setTrust(durable, "trusted");
    // A directory at the atomic temporary-file prefix makes every random
    // staging path impossible only if the target itself is replaced. Instead,
    // make the parent non-writable after seeding a valid readable registry.
    if (process.platform === "win32") return;
    const parent = join(root, "desktop");
    await chmod(parent, 0o500);
    try {
      await expect(setTrust(rejected, "trusted")).rejects.toThrow();
      expect(getTrustCachedSync(durable)).toBe("trusted");
      expect(getTrustCachedSync(rejected)).toBe("unknown");
    } finally {
      await chmod(parent, 0o700);
    }
  });

  test("fails closed on oversized registries", async () => {
    const projectPath = join(root, "oversized-project");
    await mkdir(join(root, "desktop"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ [projectPath]: "trusted", padding: "x".repeat(4 * 1024 * 1024) }),
    );

    await warmTrustCache();
    expect(getTrustCachedSync(projectPath)).toBe("unknown");
    expect(await getTrust(projectPath)).toBe("unknown");
  });

  test("rejects a linked registry without touching its target", async () => {
    const projectPath = join(root, "linked-project");
    const outside = join(root, "outside.json");
    await mkdir(join(root, "desktop"), { recursive: true });
    await writeFile(outside, JSON.stringify({ [projectPath]: "trusted" }));
    await symlink(outside, file);

    await warmTrustCache();
    expect(getTrustCachedSync(projectPath)).toBe("unknown");
    await expect(setTrust(projectPath, "trusted")).rejects.toThrow(/regular file/);
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual({ [projectPath]: "trusted" });
  });
});
