import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit opt-in: independent, reviewed Services source and packed public packages.
const args = process.argv.slice(2);
if (
  args[0] !== "--run" ||
  (args.length !== 5 && args.length !== 6) ||
  args[1] !== "--services-dir" ||
  args[3] !== "--packed-consumer" ||
  (args.length === 6 && args[5] !== "--fail-after-open")
) {
  throw new Error(
    "Usage: node scripts/smoke-cloud-main-services.mjs --run --services-dir <Services checkout> --packed-consumer <real tarball consumer> [--fail-after-open]",
  );
}
const services = realpathSync(args[2]),
  packed = realpathSync(args[4]);
const expectedFailure = args[5] === "--fail-after-open";
if (
  !existsSync(join(services, "apps/account-server/cloud-authority.mjs")) ||
  !existsSync(join(packed, "node_modules/@cjhyy/code-shell-server/dist/index.serve.js"))
)
  throw new Error("Compatible Services and packed Server are required");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const packReceiptPath = resolve(packed, "../pack-receipt.json");
const packReceipt = JSON.parse(readFileSync(packReceiptPath, "utf8"));
if (packReceipt.packages?.length !== 5) throw new Error("Five-package packing receipt required");
for (const entry of packReceipt.packages) {
  if (!/^@cjhyy\/code-shell-[a-z-]+$/.test(entry.name)) throw new Error("Invalid package receipt");
  const directory = join(packed, "node_modules", entry.name);
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Workspace package symlinks refused");
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (manifest.name !== entry.name || manifest.version !== entry.version)
    throw new Error("Packed package identity changed");
  if (sha256(entry.tarball) !== entry.sha256) throw new Error("Packed tarball changed");
  for (const [path, hash] of Object.entries(entry.copiedInventory)) {
    if (!path.startsWith("dist/")) continue;
    const target = realpathSync(join(directory, path));
    const inside = relative(realpathSync(directory), target);
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(".." + sep))
      throw new Error("Packed build file escaped package");
    if (sha256(target) !== hash) throw new Error("Packed build inventory changed");
  }
}
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-main-services-")));
const home = join(root, "home");
mkdirSync(home, { mode: 0o700 });
const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: root,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  CLOUD_MAIN_HOME_HASH: createHash("sha256").update(home).digest("hex"),
  ...(expectedFailure ? { CLOUD_MAIN_FAIL_AFTER_OPEN: "1" } : {}),
};
const execute = (command, parameters) =>
  execFileSync(command, parameters, { cwd: repo, env, stdio: "pipe" });
const serviceGit = (...parameters) =>
  execFileSync("git", ["-C", services, ...parameters], { env })
    .toString()
    .trim();
let child, receipt, failure, childExit, servicesHead;
try {
  servicesHead = serviceGit("rev-parse", "HEAD");
  if (serviceGit("status", "--porcelain", "--", "apps"))
    throw new Error("Clean Services apps required");
  cpSync(join(services, "apps"), join(root, "apps"), { recursive: true });
  cpSync(join(packed, "node_modules"), join(root, "node_modules"), {
    recursive: true,
    dereference: false,
  });
  for (const name of ["cloud-main-services-child.mjs", "cloud-main-services-guard.mjs"])
    cpSync(join(repo, "scripts/fixtures", name), join(root, name));
  writeFileSync(join(root, "package.json"), '{"type":"module","private":true}');
  execute("bun", [
    "build",
    "scripts/fixtures/cloud-main-services-adapters.ts",
    "--target=node",
    "--packages=external",
    "--outfile",
    join(root, "adapters.mjs"),
  ]);
  writeFileSync(
    join(root, "leaf.ext"),
    "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
    { mode: 0o600 },
  );
  for (const name of ["account", "cloud"]) {
    execute("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${name}-interop-CA`,
      "-keyout",
      join(root, name + "-ca.key"),
      "-out",
      join(root, name + "-ca.pem"),
    ]);
    execute("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${name}-interop`,
      "-keyout",
      join(root, name + ".key"),
      "-out",
      join(root, name + ".csr"),
    ]);
    execute("openssl", [
      "x509",
      "-req",
      "-in",
      join(root, name + ".csr"),
      "-CA",
      join(root, name + "-ca.pem"),
      "-CAkey",
      join(root, name + "-ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      join(root, "leaf.ext"),
      "-out",
      join(root, name + ".pem"),
    ]);
  }
  writeFileSync(
    join(root, "authority-ca.pem"),
    ["account", "cloud"]
      .map((name) => readFileSync(join(root, name + "-ca.pem"), "utf8"))
      .join("\n"),
  );
  // Services' real global fetch retains native TLS verification with these fixture CAs.
  env.NODE_EXTRA_CA_CERTS = join(root, "authority-ca.pem");
  child = spawn(
    process.execPath,
    ["--unhandled-rejections=strict", join(root, "cloud-main-services-child.mjs"), root],
    {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-6000);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
  try {
    childExit = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    });
    const reported = stdout.trim().split("\n").at(-1);
    if (reported?.startsWith("{")) receipt = JSON.parse(reported);
    if (
      expectedFailure &&
      childExit.code === 1 &&
      !childExit.signal &&
      receipt?.status === "injected-failure" &&
      receipt.ownedListenersAndSocketsClosed === true
    ) {
      receipt.status = "passed";
      receipt.injectedFailureCleanupVerified = true;
    } else if (childExit.code !== 0 || childExit.signal || expectedFailure)
      throw new Error("Main/Services HTTPS interop failed: " + stderr);
    receipt.hostHead = execute("git", ["rev-parse", "HEAD"]).toString().trim();
    if (
      serviceGit("rev-parse", "HEAD") !== servicesHead ||
      serviceGit("status", "--porcelain", "--", "apps")
    )
      throw new Error("Services source changed during interop");
    receipt.servicesHead = servicesHead;
    receipt.packedConsumer = packed;
    receipt.packedHostHead = packReceipt.hostHead;
    receipt.packedTarballSha256 = Object.fromEntries(
      packReceipt.packages.map((entry) => [entry.name, entry.sha256]),
    );
    receipt.packedBuildInventoryVerified = true;
    receipt.smokeSourceSha256 = Object.fromEntries(
      [
        "scripts/smoke-cloud-main-services.mjs",
        "scripts/fixtures/cloud-main-services-adapters.ts",
        "scripts/fixtures/cloud-main-services-child.mjs",
        "scripts/fixtures/cloud-main-services-guard.mjs",
      ].map((path) => [path, sha256(join(repo, path))]),
    );
    receipt.ownedChildExited = true;
    receipt.childExit = childExit;
  } finally {
    clearTimeout(timer);
  }
} catch (error) {
  failure = error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((done) => child.once("exit", done));
  }
  rmSync(root, { recursive: true, force: true });
}
if (receipt) {
  receipt.privateFixtureRemoved = !existsSync(root);
  console.log(JSON.stringify(receipt, null, 2));
}
if (failure) throw failure;
