import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEVICE_RELAY_ACCEPTANCE_CHECKS } from "../scripts/device-relay-acceptance-contract.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const wrapper = resolve(import.meta.dirname, "../scripts/smoke-device-relay.mjs");
function fixture(action = "", options: { missing?: boolean; signal?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-gate-test-"));
  roots.push(root);
  const directory = join(root, "scripts/fixtures/device-relay-acceptance");
  mkdirSync(directory, { recursive: true });
  const manifest = join(root, "device-relay-candidate.json");
  const output = join(root, "evidence.json");
  const launched = join(root, "launched");
  const cleaned = join(root, "cleaned");
  writeFileSync(
    manifest,
    JSON.stringify({ hostHead: "a".repeat(40), servicesHead: "b".repeat(40), packages: [{}] }),
  );
  writeFileSync(
    join(directory, "run.mjs"),
    `import {writeFileSync,readFileSync} from "node:fs";
    import {join} from "node:path";
    import {createHash} from "node:crypto";
    const manifestBytes=readFileSync(process.argv[4]);
    const manifest=JSON.parse(manifestBytes);
    const receipt={candidateOnly:true,protocolVersion:1,passed:true,cleanupPassed:true,
      runtime:process.version,hostHead:manifest.hostHead,servicesHead:manifest.servicesHead,
      manifestSha256:createHash("sha256").update(manifestBytes).digest("hex"),
      details:{authShutdown:{passed:true,realScryptActions:["setup","login"],waitedForHandlersBeforeReleasingDirectory:true}},
      results:${JSON.stringify(DEVICE_RELAY_ACCEPTANCE_CHECKS.map((name) => ({ name, status: "pass" })))} };
    writeFileSync(${JSON.stringify(launched)},process.env.TMPDIR);
    writeFileSync(join(process.env.TMPDIR,"private-fixture-key"),"test-only");
    ${action}
    function report(){${options.missing ? "" : 'writeFileSync(process.argv[2],JSON.stringify(receipt),{flag:"wx"});'}}
    ${
      options.signal
        ? `process.on("SIGTERM",()=>setTimeout(()=>{writeFileSync(${JSON.stringify(cleaned)},"yes");report();process.exit(0)},30));setInterval(()=>{},1000);console.log("ready");`
        : "report();"
    }`,
  );
  const args = [wrapper, root, manifest, output];
  return {
    root,
    output,
    launched,
    cleaned,
    args,
    run: () => execFileSync("node", args, { stdio: "pipe", timeout: 10000 }).toString(),
    scratch: () => readFileSync(launched, "utf8"),
  };
}

describe("installed device relay candidate gate", () => {
  test("accepts every required stage from the matching candidate and removes private temporary data", () => {
    const candidate = fixture();
    expect(candidate.run()).toContain("evidence verified");
    expect(JSON.parse(readFileSync(candidate.output, "utf8")).results).toHaveLength(14);
    expect(existsSync(candidate.scratch())).toBe(false);
  });
  for (const [name, action] of [
    ["a failed real-network check", 'receipt.results[0].status="fail";'],
    ["a missing revocation check", "receipt.results.splice(7,1);"],
    ["failed cleanup", "receipt.cleanupPassed=false;"],
    ["missing auth shutdown coverage", "delete receipt.details.authShutdown;"],
    [
      "releasing the directory before auth settles",
      "receipt.details.authShutdown.waitedForHandlersBeforeReleasingDirectory=false;",
    ],
    ["another source revision", 'receipt.hostHead="c".repeat(40);'],
    ["another package manifest", 'receipt.manifestSha256="c".repeat(64);'],
    ["a changed candidate during acceptance", 'writeFileSync(process.argv[4],"{}");'],
  ])
    test(`rejects ${name} despite exit zero and cleans its scratch directory`, () => {
      const candidate = fixture(action);
      expect(candidate.run).toThrow();
      expect(existsSync(candidate.scratch())).toBe(false);
    });
  test("rejects silent exit zero without new evidence", () => {
    const candidate = fixture("", { missing: true });
    expect(candidate.run).toThrow();
    expect(existsSync(candidate.scratch())).toBe(false);
  });
  test("preserves old evidence and rejects it before launching", () => {
    const candidate = fixture();
    writeFileSync(candidate.output, "previous run");
    expect(candidate.run).toThrow("new file");
    expect(existsSync(candidate.launched)).toBe(false);
    expect(readFileSync(candidate.output, "utf8")).toBe("previous run");
  });
  test("waits for cooperative cleanup but never accepts an interrupted successful child", async () => {
    const candidate = fixture("", { signal: true });
    const child = spawn("node", candidate.args, { stdio: ["ignore", "pipe", "pipe"] });
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
      expect(readFileSync(candidate.cleaned, "utf8")).toBe("yes");
      expect(existsSync(candidate.scratch())).toBe(false);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  });
});
