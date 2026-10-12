import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native cloud uses authenticated project RPC, history, approvals and recovery without a webpage", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cs-native-cloud-node-"));
  try {
    await symlink(resolve(import.meta.dir, "../../node_modules"), join(temporary, "node_modules"));
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        join(import.meta.dir, "cloud-environment-node.fixture.ts"),
        "--target=node",
        `--outfile=${join(temporary, "fixture.mjs")}`,
        "--external=ws",
        "--external=@cjhyy/code-shell-core",
        "--external=@cjhyy/code-shell-core/internal",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [buildError, buildExit] = await Promise.all([
      new Response(build.stderr).text(),
      build.exited,
    ]);
    expect(buildError).toBe("");
    expect(buildExit).toBe(0);
    // Node preload runs before bundled Core imports, with no initially allowed network origin.
    const guard = join(temporary, "network-guard.mjs");
    await writeFile(
      guard,
      `
const allowed = globalThis.__codeshellCloudFixtureOrigins = new Set();
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!allowed.has(url.origin)) throw new Error('fixture blocked unexpected origin: ' + url.origin);
  return nativeFetch(input, init);
};
`,
    );
    const child = Bun.spawn(["node", "--import", guard, join(temporary, "fixture.mjs")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 25_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ passed: 3 });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
