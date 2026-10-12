import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
  guard: {
    version: 1,
    preCore: true,
    hostHead: "d".repeat(40),
    controllerProcesses: 3,
    cliProcesses: 7,
    nativeEgressAcks: 2,
    bootstrapReleases: 2,
    children: 0,
    helperRemoved: true,
  },
  checks: [
    "live-controller and busy-volume rejection",
    "new installation, both volume bytes, permissions and links, original preservation",
    "old session revocation, fresh login, stopped projects, actual runtime restart and rebackup",
    "corruption rejection and incomplete restore remains unstartable",
  ],
};
function guardArguments(root: string) {
  const file = join(root, "guard.json");
  const bytes = JSON.stringify({
    version: 1,
    hostHead: "d".repeat(40),
    runtime: { imageId: runtime },
    docker: { endpoint: "unix:///fixture/docker.sock" },
  });
  writeFileSync(file, bytes, { mode: 0o600 });
  return ["--guard", file, createHash("sha256").update(bytes).digest("hex")];
}
function ownMaterial(metadata: string) {
  return `const inner=process.env.HOME+"/codeshell-cloud-restore-owned";mkdirSync(inner,{mode:448});writeFileSync(inner+"/source-proof","original fixture evidence");writeFileSync(${JSON.stringify(metadata)},JSON.stringify({home:process.env.HOME,inner}));`;
}
function material(metadata: string) {
  return JSON.parse(readFileSync(metadata, "utf8")) as { home: string; inner: string };
}
function rememberClosedCustody(metadata: string) {
  if (!existsSync(metadata)) return;
  const value = material(metadata),
    root = dirname(value.home);
  expect(basename(root).startsWith("codeshell-restore-wrapper-")).toBe(true);
  expect(value.home).toBe(join(root, "home"));
  roots.push(root);
}
function assertPreserved(metadata: string) {
  expect(readFileSync(join(material(metadata).inner, "source-proof"), "utf8")).toBe(
    "original fixture evidence",
  );
}
function fixture(receipt: unknown) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-restore-wrapper-")));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  const launched = join(root, "launched"),
    output = join(root, "evidence.json");
  const metadata = join(root, "material.json");
  writeFileSync(
    join(root, "scripts/smoke-cloud-restore.mjs"),
    `import {mkdirSync,writeFileSync} from "node:fs";${ownMaterial(metadata)}writeFileSync(${JSON.stringify(launched)},"yes");${receipt === undefined ? "" : receipt === "write-failure" ? 'mkdirSync(process.argv[5]);writeFileSync(process.argv[5],"cannot publish");' : `writeFileSync(process.argv[5],${JSON.stringify(JSON.stringify(receipt))},{flag:"wx"});`}`,
  );
  const guard = guardArguments(root);
  return {
    output,
    launched,
    metadata,
    run: () => {
      let closed: boolean | undefined;
      try {
        const output = execFileSync(
          "node",
          [wrapper, root, runtime, helper, source, join(root, "evidence.json"), ...guard],
          { stdio: "pipe", timeout: 10000 },
        ).toString();
        closed = true;
        return output;
      } catch (error) {
        closed = Number.isInteger((error as { status?: number }).status);
        throw error;
      } finally {
        // Only dispose this synthetic child's material after captured wrapper
        // close. Unknown timeout/process custody is deliberately retained.
        if (closed) rememberClosedCustody(metadata);
      }
    },
  };
}
describe("installed Cloud backup/restore candidate gate", () => {
  test("accepts a fresh complete receipt with matching images", () => {
    const test = fixture(proof);
    expect(test.run()).toContain("evidence verified");
    expect(JSON.parse(readFileSync(test.output, "utf8"))).toEqual(proof);
    expect(existsSync(material(test.metadata).inner)).toBe(false);
    expect(existsSync(dirname(material(test.metadata).home))).toBe(false);
  });
  for (const [name, receipt] of [
    ["silent success without evidence", undefined],
    ["receipt publication failure", "write-failure"],
    ["failed recovery", { ...proof, passed: false }],
    ["failed cleanup", { ...proof, cleanupPassed: false }],
    ["other runtime", { ...proof, runtimeImage: helper }],
    ["other helper source", { ...proof, helperSource: "different" }],
    ["missing restore stage", { ...proof, checks: proof.checks.slice(1) }],
    ["missing guard proof", { ...proof, guard: undefined }],
    ["missing runtime ACK", { ...proof, guard: { ...proof.guard, nativeEgressAcks: 1 } }],
    ["unclosed child", { ...proof, guard: { ...proof.guard, children: 1 } }],
  ] as const)
    test(`rejects ${name} and preserves actual inner custody`, () => {
      const test = fixture(receipt);
      expect(test.run).toThrow();
      assertPreserved(test.metadata);
    });
  test("rejects stale evidence before launching any restore process", () => {
    const test = fixture(proof);
    const original = JSON.stringify(proof);
    writeFileSync(test.output, original);
    expect(test.run).toThrow("new file");
    expect(existsSync(test.launched)).toBe(false);
    expect(readFileSync(test.output, "utf8")).toBe(original);
  });
  test("forwards termination, waits for child cleanup, and rejects interrupted success", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-restore-signal-")));
    roots.push(root);
    mkdirSync(join(root, "scripts"));
    const output = join(root, "evidence.json");
    const cleaned = join(root, "cleaned");
    const metadata = join(root, "material.json");
    writeFileSync(
      join(root, "scripts/smoke-cloud-restore.mjs"),
      `import {mkdirSync,writeFileSync} from "node:fs";${ownMaterial(metadata)}
      process.on("SIGTERM",()=>setTimeout(()=>{writeFileSync(${JSON.stringify(cleaned)},"yes");writeFileSync(process.argv[5],${JSON.stringify(JSON.stringify(proof))});process.exit(0)},30));
      setInterval(()=>{},1000);console.log("ready");`,
    );
    const guard = guardArguments(root);
    const child = spawn("node", [wrapper, root, runtime, helper, source, output, ...guard], {
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
      assertPreserved(metadata);
      rememberClosedCustody(metadata);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  });
});
