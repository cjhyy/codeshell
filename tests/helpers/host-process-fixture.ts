import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInSubprocess } from "./bundle-in-subprocess.js";

const desktop = fileURLToPath(new URL("../../packages/desktop/", import.meta.url));

export async function runHostProcessFixture(
  name: string,
  environment?: (root: string) => Record<string, string>,
) {
  const root = await mkdtemp(join(tmpdir(), name + "-"));
  let bundle: string | undefined;
  try {
    // The bundle must resolve both Desktop dependencies and dependencies hoisted
    // to the workspace root. Keep the simulated user's data in a separate HOME.
    bundle = await mkdtemp(join(desktop, ".native-fixture-"));
    bundleInSubprocess([join(desktop, "scripts", "__fixtures__", name + ".ts")], bundle, {
      naming: "fixture.mjs",
      packages: "external",
    });
    const child = Bun.spawn(["node", join(bundle, "fixture.mjs"), root], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        CODE_SHELL_HOME: join(root, ".code-shell"),
        ...environment?.(root),
      },
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw Error(name + " exited " + code + "\n" + error + output);
      return output;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await Promise.all(
      [root, ...(bundle ? [bundle] : [])].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}
