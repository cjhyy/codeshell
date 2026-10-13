// Execute the frozen, dependency-free Panel only as far as its native spawn.
// No browser, Docker, Core, socket or native processor is started here.
import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installDockerCandidateGuard } from "../../scripts/docker-candidate-guard.mjs";

const home = fs.realpathSync(process.env.HOME);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const preload = new URL("../../scripts/docker-candidate-preload.mjs", import.meta.url).pathname;
const guardPath = new URL("../../scripts/docker-candidate-guard.mjs", import.meta.url).pathname;
process.env.NODE_OPTIONS = `--import=${preload}`;
const receipt = join(home, "guard.jsonl");
installDockerCandidateGuard({
  version: 1,
  role: "installer",
  home,
  dataRoot: home,
  preload,
  preloadHash: hash(fs.readFileSync(preload)),
  guardHash: hash(fs.readFileSync(guardPath)),
  receipt,
  origins: [],
  listeners: [],
  children: [],
});
assert.throws(() => fetch("https://external.invalid/"), /Docker candidate refused/);

const jobId = "1f533283-e3b9-49f5-957b-cdb7b90c3948";
const otherJobId = "9ff49449-2287-4f5d-bc2e-6acd9fbf3d10";
const data = join(home, "container", "data");
const workspace = join(home, "container", "workspace");
const work = join(data, "panel-tool-jobs", jobId, "work");
fs.mkdirSync(work, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const literalWork = `/data/panel-tool-jobs/${jobId}/work`;
process.chdir(work); // The Host starts the reviewed task in this granted work directory.
const realpath = fs.realpathSync;
const lstat = fs.lstatSync;
// Changing a real file's owner would require operator/root authority. Only the
// explicit wrong-owner negative cases substitute uid; all positive metadata,
// chmod, symlink and canonical-path cases use the real temporary filesystem.
const wrongOwner = new Set();
const mounts = [
  ["/data", data],
  ["/workspace", workspace],
];
function physical(path) {
  for (const [literal, actual] of mounts) {
    if (typeof path === "string" && (path === literal || path.startsWith(`${literal}/`))) {
      const mapped = resolve(actual, `.${path.slice(literal.length)}`);
      assert(mapped === actual || mapped.startsWith(`${actual}/`));
      return mapped;
    }
  }
  return path;
}
function literal(path) {
  for (const [prefix, actual] of mounts)
    if (path === actual || path.startsWith(`${actual}/`)) return prefix + path.slice(actual.length);
  return path;
}
// Virtualize only the literal container mount names. Files, modes, symlinks and
// canonicalization remain real private temporary filesystem operations. Neither
// /data nor /workspace is created on the operator's machine.
fs.realpathSync = (path, ...args) => literal(realpath(physical(path), ...args));
fs.lstatSync = (path, ...args) => {
  const stat = lstat(physical(path), ...args);
  return wrongOwner.has(path)
    ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 })
    : stat;
};
syncBuiltinESMExports();

const source = fs.readFileSync(new URL("./job-resume-pdf-75431542.mjs.txt", import.meta.url));
const sourceHash = hash(source);
assert.equal(sourceHash, "fa5277ab082278f3db128fadc08d5c9b40d56bdb163aa3ccfcc3d47b40999f7e");
const entry = join(home, "resume-pdf.mjs");
fs.writeFileSync(entry, source, { flag: "wx", mode: 0o600 });
const executable = join(home, "chromium");
fs.writeFileSync(executable, "never executed\n", { flag: "wx", mode: 0o700 });
process.env.CODESHELL_PDF_BROWSER = executable;
const validate = (await import("../../scripts/docker-candidate-native-argv.mjs"))
  .validateCandidateNativeArguments;
const blocked = /Docker candidate native argv refused/;
const stopped = new Error("Stopped before native browser execution");
const scenario = process.argv[2];
let captured;
const guardedSpawn = children.spawn;
children.spawn = (path, args, options) => {
  if (path !== executable) return guardedSpawn(path, args, options);
  assert.equal(captured, undefined);
  assert.deepEqual(options, {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  captured = args.map((arg) =>
    arg.startsWith("--user-data-dir=")
      ? `--user-data-dir=${literal(arg.slice("--user-data-dir=".length))}`
      : arg,
  );
  const inheritedCwd = literal(options.cwd ?? process.cwd());
  assert.equal(inheritedCwd, literalWork);
  if (scenario === "consumer") validate("/usr/bin/chromium", captured, inheritedCwd);
  throw stopped;
};
syncBuiltinESMExports();
const { renderResumePdf } = await import(pathToFileURL(entry).href);
await assert.rejects(
  renderResumePdf(
    { action: "resume-pdf", html: "<main>Controlled fixture</main>" },
    { directory: work },
  ),
  (error) => error === stopped,
);
assert.equal(captured.length, 12);
assert.equal(fs.readdirSync(work).length, 0); // Real Panel finally removed its profile.

function argv(profile) {
  return captured.map((arg) =>
    arg.startsWith("--user-data-dir=") ? `--user-data-dir=${profile}` : arg,
  );
}
function directory(path) {
  fs.mkdirSync(physical(path), { recursive: true, mode: 0o700 });
  return path;
}
const profile = directory(`${literalWork}/.pdf-browser-aB0123`);
let cases = 1;
if (scenario === "boundaries") {
  const refuse = (args, cwd = literalWork) => {
    assert.throws(() => validate("/usr/bin/chromium", args, cwd), blocked);
    cases++;
  };
  refuse(argv(directory(`/data/panel-tool-jobs/${otherJobId}/work/.pdf-browser-aB0123`)));
  refuse(argv(profile), `/data/panel-tool-jobs/${otherJobId}/work`);
  refuse(argv(directory(`/data/panel-tool-jobs/${jobId}/not-work/.pdf-browser-aB0123`)));
  refuse(argv(directory("/data/panel-tool-jobs/not-a-uuid/work/.pdf-browser-aB0123")));
  refuse(argv(directory("/data/unrelated/.pdf-browser-aB0123")));
  refuse(argv("/tmp/unrelated/.pdf-browser-aB0123"));
  refuse(argv(`${literalWork}/../work/.pdf-browser-aB0123`));
  refuse(argv(directory(`${literalWork}/.pdf-browser-aB01234`)));
  refuse([...argv(profile).slice(0, -1), "--no-sandbox", "about:blank"]);
  refuse(
    argv(profile).map((arg) =>
      arg === "--disable-background-networking" ? "--disable-web-security" : arg,
    ),
  );
  for (const path of [profile, literalWork]) {
    fs.chmodSync(physical(path), 0o755);
    try {
      refuse(argv(profile));
    } finally {
      fs.chmodSync(physical(path), 0o700);
    }
    wrongOwner.add(path);
    try {
      refuse(argv(profile));
    } finally {
      wrongOwner.delete(path);
    }
  }
  const link = `${literalWork}/.pdf-browser-sY0123`;
  fs.symlinkSync(physical(profile), physical(link));
  refuse(argv(link));
  const linkWork = `/data/panel-tool-jobs/${otherJobId}/work`;
  fs.renameSync(physical(linkWork), physical(`${linkWork}-original`));
  fs.symlinkSync(work, physical(linkWork));
  refuse(argv(`${linkWork}/.pdf-browser-aB0123`), linkWork);
  assert.doesNotThrow(() => validate("/usr/bin/chromium", argv(profile), literalWork));
  cases++;
} else if (scenario === "legacy") {
  for (const base of ["/workspace/existing", "/data/home/existing"]) {
    const legacy = directory(`${base}/.pdf-browser-aB0123`);
    // Old consumers do not acquire a new cwd/ancestor-private requirement.
    fs.chmodSync(physical(base), 0o755);
    assert.doesNotThrow(() => validate("/usr/bin/chromium", argv(legacy), "/unrelated-old-cwd"));
    cases++;
    fs.chmodSync(physical(legacy), 0o755);
    assert.throws(() => validate("/usr/bin/chromium", argv(legacy)), blocked);
    cases++;
    fs.chmodSync(physical(legacy), 0o700);
    wrongOwner.add(legacy);
    assert.throws(() => validate("/usr/bin/chromium", argv(legacy)), blocked);
    wrongOwner.delete(legacy);
    cases++;
    const alias = `${base}/.pdf-browser-lN0123`;
    fs.symlinkSync(physical(legacy), physical(alias));
    assert.throws(() => validate("/usr/bin/chromium", argv(alias)), blocked);
    cases++;
  }
} else assert.equal(scenario, "consumer");
assert.throws(() => children.spawn("unreviewed-native", []), /Docker candidate refused/);
const receipts = fs.readFileSync(receipt, "utf8").trim().split("\n").map(JSON.parse);
assert.equal(receipts.filter((event) => event.event === "pre-core").length, 1);
assert.equal(receipts[0].negativeProbes, 6);
assert.equal(receipts[0].dnsNegativeProbes, 4);
const nativeChildStarts = receipts.filter((event) => event.event === "child-started").length;
assert.equal(nativeChildStarts, 0);
console.log(
  JSON.stringify({ scenario, cases, sourceHash, argvCount: captured.length, nativeChildStarts }),
);
