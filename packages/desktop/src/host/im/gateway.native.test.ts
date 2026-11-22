import { bundleInSubprocess } from "../../../../../tests/helpers/bundle-in-subprocess.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
test("hosted IM control, saved setup and outbox survive a real utility restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-host-im-"));
  let bundle: string | undefined;
  try {
    // Node resolves an external from the bundle's ancestors. A fresh Windows
    // checkout may hoist dependencies above the Desktop node_modules folder.
    bundle = await mkdtemp(resolve("packages/desktop/.im-native-test-"));
    bundleInSubprocess(
      [resolve("packages/desktop/scripts/__fixtures__/hosted-im-gateway.ts")],
      bundle,
      {
        naming: "fixture.mjs",
        packages: "external",
      },
    );
    const child = Bun.spawn(["node", join(bundle, "fixture.mjs"), root], {
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
    await Promise.all(
      [root, ...(bundle ? [bundle] : [])].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}, 40000);
