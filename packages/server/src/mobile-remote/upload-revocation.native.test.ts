import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("native device revocation stops unclaimed uploads but preserves other phones and accepted claims", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "upload-revocation-"));
  try {
    const source = dirname(fileURLToPath(import.meta.url));
    const root = resolve(source, "../../../..");
    await symlink(resolve(source, "../../node_modules"), join(temporary, "node_modules"));
    const build = Bun.spawn(
      [
        "bun",
        "build",
        ...["remote-host-manager", "trusted-device-store", "mobile-upload-service"].map((name) =>
          resolve(source, `${name}.ts`),
        ),
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
      ["node", resolve(root, "tests/fixtures/upload-revocation.mjs"), temporary],
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
      expect(stdout).toContain("PASS device upload revocation");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 25_000);
