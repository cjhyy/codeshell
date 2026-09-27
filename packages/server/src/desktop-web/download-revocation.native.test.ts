import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

for (const mode of ["desktop", "hub"] as const) {
  test(`native ${mode} revocation stops active file reads without cancelling another session`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), "download-revocation-"));
    try {
      const source = dirname(fileURLToPath(import.meta.url));
      const root = resolve(source, "../../../..");
      await symlink(resolve(source, "../../node_modules"), join(temporary, "node_modules"));
      // Build in a separate process as well: unrelated Bun suites may have
      // installed module mocks or browser globals in the test runner.
      const build = Bun.spawn(
        [
          "bun",
          "build",
          resolve(source, "http-api.ts"),
          ...["remote-host-manager", "trusted-device-store"].map((name) =>
            resolve(source, `../mobile-remote/${name}.ts`),
          ),
          resolve(source, "../serve/headless-server.ts"),
          "--target=node",
          "--packages=external",
          "--outdir",
          temporary,
          "--entry-naming",
          "[name].js",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [buildOut, buildError, buildCode] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      expect(buildCode, `${buildOut}\n${buildError}`).toBe(0);
      await writeFile(join(temporary, "package.json"), '{"type":"module"}');
      const child = Bun.spawn(
        ["node", resolve(root, "tests/fixtures/download-revocation.mjs"), temporary, mode],
        { stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => child.kill(), 20_000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        expect(stdout).toContain(`PASS ${mode} file revocation`);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 25_000);
}
