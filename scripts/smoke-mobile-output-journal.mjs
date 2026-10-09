import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";
assert.ok(
  process.env.CODE_SHELL_TEST_HOME && process.env.CODE_SHELL_HOME,
  "Use the isolated native launcher",
);
assert.equal(process.env.HOME, realpathSync(process.env.HOME));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(repo, "packages/desktop/node_modules/.cache");
mkdirSync(cache, { recursive: true });
const directory = mkdtempSync(join(cache, "mobile-output-journal-"));
const fixture = join(directory, "fixture.mjs");
const root = mkdtempSync(join(process.env.CODE_SHELL_TEST_HOME, "mobile-native-"));
const portServer = createServer();
await new Promise((done) => portServer.listen(0, "127.0.0.1", done));
const port = portServer.address().port;
await new Promise((done) => portServer.close(done));
const origin = `http://127.0.0.1:${port}`;
// A fixture regression cannot consume the CI job's default multi-hour timeout.
const deadline = setTimeout(() => {
  console.error("Mobile output journal smoke exceeded its 90-second deadline");
  process.exit(1);
}, 90_000);
try {
  const built = spawnSync(
    "bun",
    [
      "build",
      "scripts/fixtures/mobile-output-journal.tsx",
      "--target=node",
      "--packages=external",
      "--outfile",
      fixture,
    ],
    { cwd: repo, env: process.env, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(built.status, 0, built.stderr);
  installLocalNetworkGuard(origin);
  assert.throws(() => fetch("https://api.openai.com/v1/models"), /non-fixture/);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  console.log(
    JSON.stringify({
      mobilePreImportGuard: true,
      pid: process.pid,
      ppid: process.ppid,
      homeHash: hash(process.env.HOME),
      origin,
      negativeProbe: true,
      fixtureHash: hash((await import("node:fs")).readFileSync(fixture)),
    }),
  );
  const { run } = await import(pathToFileURL(fixture));
  await run(origin, root, port);
} finally {
  clearTimeout(deadline);
  rmSync(directory, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
