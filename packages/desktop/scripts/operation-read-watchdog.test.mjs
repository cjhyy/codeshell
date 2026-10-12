import { equal } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";

test(
  "operation-read confinement permits only the watchdog's fixed process metadata query",
  { skip: process.platform === "win32" ? "POSIX process metadata query" : false },
  (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "operation-watchdog-guard-test-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const environment = createBunTestEnvironment(process.env, root);
    environment.CODESHELL_COST_SMOKE_ORIGIN = "http://127.0.0.1:9";
    environment.CODESHELL_COST_SMOKE_HOME_ID = createHash("sha256")
      .update(environment.HOME)
      .digest("hex");
    writeFileSync(join(environment.HOME, "operation-read-source.json"), "{}", { mode: 0o600 });
    const source = `
import assert from "node:assert/strict";
import children from "node:child_process";
await import(${JSON.stringify(new URL("./operation-read-guard.mjs", import.meta.url).href)});
const processes = children.execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
  env: { PATH: "/invalid", LC_ALL: "invalid" },
});
assert.equal(typeof processes, "string");
assert.equal(processes.split(String.fromCharCode(10)).some((line) =>
  Number(line.trim().split(" ").filter(Boolean)[0]) === process.pid), true);
assert.throws(() => children.execFileSync("/bin/ps", ["eww"]), /refused external child/);
assert.throws(() => children.spawn("/bin/ps", ["-axo", "pid=,ppid=,lstart="]), /refused external child/);
assert.throws(() => children.execFileSync("/bin/ps", ["-axo", "command="]), /refused external child/);
process.stdout.write("fixed process metadata allowed; other ps modes refused\\n");
`;
    const child = spawnSync(
      process.versions.bun ? "node" : process.execPath,
      ["--input-type=module", "-e", source],
      { env: environment, encoding: "utf8", timeout: 10_000 },
    );
    equal(child.status, 0, child.stderr);
    equal(child.stdout, "fixed process metadata allowed; other ps modes refused\n");
  },
);
