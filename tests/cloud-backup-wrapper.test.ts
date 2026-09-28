import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const wrapper = resolve(import.meta.dirname, "../scripts/smoke-cloud-backup.mjs");
const runtime = `sha256:${"a".repeat(64)}`;
const helper = `sha256:${"b".repeat(64)}`;
const source = `node:22-bookworm-slim@sha256:${"c".repeat(64)}`;
const proof = {
  candidateOnly: true,
  runtimeImage: runtime,
  helperImage: helper,
  helperSource: source,
  runtimePlatform: "linux/amd64",
  helperPlatform: "linux/amd64",
  helperIncludedInCandidate: false,
  passed: true,
  cleanupPassed: true,
  checks: [
    "live-controller and busy-volume rejection",
    "new installation, both volume bytes, permissions and links, original preservation",
    "old session revocation, fresh login, stopped projects, actual runtime restart and rebackup",
    "corruption rejection and incomplete restore remains unstartable",
  ],
};
function fixture(receipt: unknown) {
  const root = mkdtempSync(join(tmpdir(), "cloud-restore-wrapper-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  const launched = join(root, "launched"),
    output = join(root, "evidence.json");
  writeFileSync(
    join(root, "scripts/smoke-cloud-restore.mjs"),
    `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(launched)},"yes");${receipt === undefined ? "" : `writeFileSync(process.argv[5],${JSON.stringify(JSON.stringify(receipt))},{flag:"wx"});`}`,
  );
  return {
    output,
    launched,
    run: () =>
      execFileSync("node", [wrapper, root, runtime, helper, source, output], {
        stdio: "pipe",
        timeout: 10000,
      }).toString(),
  };
}
describe("installed Cloud backup/restore candidate gate", () => {
  test("accepts a fresh complete receipt with matching images", () => {
    const test = fixture(proof);
    expect(test.run()).toContain("evidence verified");
    expect(JSON.parse(readFileSync(test.output, "utf8"))).toEqual(proof);
  });
  for (const [name, receipt] of [
    ["silent success without evidence", undefined],
    ["failed recovery", { ...proof, passed: false }],
    ["failed cleanup", { ...proof, cleanupPassed: false }],
    ["other runtime", { ...proof, runtimeImage: helper }],
    ["other helper source", { ...proof, helperSource: "different" }],
    ["missing restore stage", { ...proof, checks: proof.checks.slice(1) }],
  ] as const)
    test(`rejects ${name} even when the child exits zero`, () =>
      expect(fixture(receipt).run).toThrow());
  test("rejects stale evidence before launching any restore process", () => {
    const test = fixture(proof);
    const original = JSON.stringify(proof);
    writeFileSync(test.output, original);
    expect(test.run).toThrow("new file");
    expect(existsSync(test.launched)).toBe(false);
    expect(readFileSync(test.output, "utf8")).toBe(original);
  });
  test("forwards termination, waits for child cleanup, and rejects interrupted success", async () => {
    const root = mkdtempSync(join(tmpdir(), "cloud-restore-signal-"));
    roots.push(root);
    mkdirSync(join(root, "scripts"));
    const output = join(root, "evidence.json");
    const cleaned = join(root, "cleaned");
    writeFileSync(
      join(root, "scripts/smoke-cloud-restore.mjs"),
      `import {writeFileSync} from "node:fs";
      process.on("SIGTERM",()=>setTimeout(()=>{writeFileSync(${JSON.stringify(cleaned)},"yes");writeFileSync(process.argv[5],${JSON.stringify(JSON.stringify(proof))});process.exit(0)},30));
      setInterval(()=>{},1000);console.log("ready");`,
    );
    const child = spawn("node", [wrapper, root, runtime, helper, source, output], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "close");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      await once(child.stdout, "data");
      child.kill("SIGTERM");
      const [code] = await exited;
      expect(code).not.toBe(0);
      expect(stderr).toContain("acceptance failed");
      expect(readFileSync(cleaned, "utf8")).toBe("yes");
      expect(JSON.parse(readFileSync(output, "utf8")).passed).toBe(true);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  });
});
