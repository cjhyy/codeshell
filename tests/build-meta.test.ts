import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("metapackage rebuild preserves both current and legacy CLI launchers", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "codeshell-build-meta-"));
  try {
    const scripts = join(fixture, "scripts");
    const fakeTui = join(fixture, "node_modules", "@cjhyy", "code-shell-tui");
    const dist = join(fixture, "dist");
    await Promise.all([
      mkdir(scripts, { recursive: true }),
      mkdir(fakeTui, { recursive: true }),
      mkdir(dist, { recursive: true }),
    ]);
    await Promise.all([
      copyFile(
        new URL("../scripts/build-meta.ts", import.meta.url),
        join(scripts, "build-meta.ts"),
      ),
      writeFile(join(fixture, "package.json"), JSON.stringify({ type: "module" })),
      writeFile(
        join(fakeTui, "package.json"),
        JSON.stringify({ type: "module", exports: { "./cli": "./cli.js" } }),
      ),
      writeFile(join(fakeTui, "cli.js"), "console.log(JSON.stringify(process.argv.slice(2)));\n"),
      writeFile(join(dist, "stale-chunk.js"), "old bundled code"),
    ]);

    // Run a fixture copy so this test never rebuilds the developer's dist/.
    const build = spawnSync(process.execPath, [join(scripts, "build-meta.ts")], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(build.status).toBe(0);
    expect(build.stderr).toBe("");
    expect(existsSync(join(dist, "stale-chunk.js"))).toBe(false);

    const args = ["link", "status", "github", "--json"];
    for (const entry of [join(dist, "cli.js"), join(dist, "cli", "main.js")]) {
      const launch = spawnSync("node", [entry, ...args], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(launch.status).toBe(0);
      expect(launch.stderr).toBe("");
      expect(JSON.parse(launch.stdout)).toEqual(args);
      expect((await stat(entry)).mode & 0o111).toBe(0o111);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
