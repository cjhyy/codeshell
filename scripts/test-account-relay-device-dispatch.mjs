import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, copyFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const services = process.env.SERVICES_CHECKOUT_PATH && resolve(process.env.SERVICES_CHECKOUT_PATH);
if (!services || !existsSync(join(services, "apps/device-relay/server.mjs")))
  throw new Error("Set SERVICES_CHECKOUT_PATH to the reviewed Services task checkout.");
const directory = realpathSync(mkdtempSync(join(tmpdir(), "account-device-e2e-")));
try {
  const built = spawnSync(
    "bun",
    [
      "build",
      join(root, "tests/fixtures/account-relay-device-runtime.ts"),
      "--target=node",
      `--outdir=${directory}`,
      "--entry-naming=runtime.mjs",
      "--packages=external",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (built.status !== 0) throw new Error(built.stderr || "Fixture build failed");
  symlinkSync(join(root, "packages/desktop/node_modules"), join(directory, "node_modules"));
  copyFileSync(
    join(root, "tests/fixtures/account-relay-device-dispatch.mjs"),
    join(directory, "fixture.mjs"),
  );
  const child = spawn(process.execPath, [join(directory, "fixture.mjs")], {
    cwd: directory,
    env: {
      ...createBunTestEnvironment(process.env, directory),
      SERVICES_CHECKOUT_PATH: services,
      CODESHELL_FIXTURE_ROOT: directory,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const timer = setTimeout(() => child.kill(), 45_000);
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  clearTimeout(timer);
  if (code !== 0) throw new Error(`Account device fixture failed (${code})`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
