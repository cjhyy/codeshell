import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const root = realpathSync(mkdtempSync(join(tmpdir(), "packaged-pet-preload-test-")));
const bootstrap = join(root, "bootstrap.cjs");
const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
buildSync({
  entryPoints: [fileURLToPath(new URL("./packaged-pet-bootstrap.mjs", import.meta.url))],
  outfile: bootstrap,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(name, override = {}) {
  const home = join(root, name);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(home, ".code-shell"), { mode: 0o700 });
  const entry = join(home, "agent-server-stdio-fixture.cjs");
  const reached = join(home, "entry-ran");
  writeFileSync(entry, `require("node:fs").writeFileSync(${JSON.stringify(reached)}, "yes");`);
  const guardLog = join(home, "guard.jsonl");
  const result = spawnSync(node, ["--require", bootstrap, entry], {
    cwd: home,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      ELECTRON_RUN_AS_NODE: "1",
      CODE_SHELL_HOME: join(home, ".code-shell"),
      CODE_SHELL_TEST_HOME: join(home, ".code-shell"),
      CODESHELL_OFFICIAL_FIXTURE_ROOT: root,
      CODESHELL_OFFICIAL_WORKER_EXECUTABLE: realpathSync(node),
      CODESHELL_COST_SMOKE_ORIGIN: "http://127.0.0.1:9",
      CODESHELL_COST_SMOKE_HOME_ID: createHash("sha256").update(home).digest("hex"),
      CODESHELL_COST_SMOKE_GUARD_LOG: guardLog,
      ...override,
    },
  });
  return { result, reached: existsSync(reached), guardLog, home };
}

describe("official packaged synchronous preimport guard", () => {
  test("real Node worker confirms private HOME and seven denied transports before entry", () => {
    const { result, reached, guardLog, home } = run("allowed");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(reached).toBe(true);
    const receipt = readFileSync(guardLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((row) => row.role === "worker");
    expect(receipt.negativeProbes).toBe(7);
    expect(receipt.homeId).toBe(createHash("sha256").update(home).digest("hex"));
    expect(receipt.executable).toBe(realpathSync(node));
    expect(receipt.ppid).toBe(process.pid);
  });
  test("a HOME equal to the fixture root fails before the entry", () => {
    const { result, reached } = run("outside", {
      CODESHELL_OFFICIAL_FIXTURE_ROOT: join(root, "outside"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HOME escaped private root");
    expect(reached).toBe(false);
  });
  test("an alternate Host storage root fails before the entry", () => {
    const { result, reached } = run("alternate", { CODE_SHELL_DATA_ROOT: "/unowned" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Host storage identity mismatch");
    expect(reached).toBe(false);
  });
  test("a worker executable other than the approved Node-mode executable fails before entry", () => {
    const { result, reached } = run("wrong-node", {
      CODESHELL_OFFICIAL_WORKER_EXECUTABLE: "/unowned/node",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Node-mode executable");
    expect(reached).toBe(false);
  });
  test("a non-loopback model origin fails before entry", () => {
    const { result, reached } = run("wrong-origin", {
      CODESHELL_COST_SMOKE_ORIGIN: "https://invalid.example",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exact HTTP loopback origin");
    expect(reached).toBe(false);
  });
});
