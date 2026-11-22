import { expect, test } from "bun:test";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
test("hosted IM control, saved setup and outbox survive a real utility restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-host-im-"));
  try {
    await symlink(
      resolve("packages/desktop/node_modules"),
      join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const built = await Bun.build({
      entrypoints: [resolve("packages/desktop/scripts/__fixtures__/hosted-im-gateway.ts")],
      outdir: root,
      naming: "fixture.mjs",
      target: "node",
      packages: "external",
    });
    expect(built.success, String(built.logs)).toBe(true);
    const child = Bun.spawn(["node", join(root, "fixture.mjs"), root], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        CODE_SHELL_HOME: join(root, ".code-shell"),
        CODE_SHELL_IM_GATEWAY_CONFIG: join(root, "config.json"),
        CODE_SHELL_DINGTALK_CLIENT_SECRET: "",
      },
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, error + output).toBe(0);
      expect(output).toContain("PASS hosted IM");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40000);
