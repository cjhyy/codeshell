// Independent package installation; no product or verifier symlinks to workspace modules.
// Build server dependencies first. Optional --docker builds the services runtime image
// and exercises two real project containers, Agent/Panel output and restart isolation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [sourceArg, ...options] = process.argv.slice(2);
let docker = false;
let outputArg;
let panelsArg;
for (let i = 0; i < options.length; i++) {
  if (options[i] === "--docker" && !docker) docker = true;
  else if (["--output", "--panels"].includes(options[i])) {
    const key = options[i];
    const value = options[++i];
    assert.ok(value && !value.startsWith("--"), `${key} needs a path`);
    if (key === "--output") {
      assert.equal(outputArg, undefined);
      outputArg = value;
    } else {
      assert.equal(panelsArg, undefined);
      panelsArg = resolve(value);
    }
  } else throw new Error(`Unknown or repeated option: ${options[i]}`);
}
if (!sourceArg || (outputArg && !docker))
  throw new Error(
    "Usage: node scripts/smoke-services-cloud-entry.mjs /path/to/codeshell-services [--panels /clean/panel-checkout] [--docker [--output /new/candidate-directory]]",
  );
const source = resolve(sourceArg);
const root = await mkdtemp(join(tmpdir(), "codeshell-services-packaged-"));
const stage = join(root, "stage");
const installed = join(root, "relocated");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
let imageId;
const images = [];
let provenance;
let sourceFiles;
let panelInventory;

function run(command, args, cwd, env = process.env, capture = false, input) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [
        input === undefined ? (capture ? "ignore" : "inherit") : "pipe",
        capture ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
    });
    let inputError;
    if (input !== undefined) {
      child.stdin.on("error", (error) => {
        inputError = error;
      });
      child.stdin.end(input);
    }
    let output = "";
    let errors = "";
    if (capture)
      child.stdout.on("data", (part) => {
        output += part;
      });
    if (capture)
      child.stderr.on("data", (part) => {
        errors += part;
      });
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 && !inputError
        ? done(output.trim())
        : fail(
            inputError ??
              new Error(`${command} ${args[0]} failed (${code}): ${errors.slice(-8000)}`),
          ),
    );
  });
}

try {
  if (outputArg) {
    await assert.rejects(
      lstat(resolve(outputArg)),
      { code: "ENOENT" },
      "Candidate output must not exist",
    );
    provenance = {};
    for (const [name, path] of [
      ["host", repo],
      ["services", source],
    ]) {
      assert.equal(
        await run("git", ["status", "--porcelain"], path, process.env, true),
        "",
        `Candidate export requires a clean ${name} checkout`,
      );
      provenance[name] = await run("git", ["rev-parse", "HEAD"], path, process.env, true);
    }
    sourceFiles = (
      await run(
        "git",
        [
          "ls-files",
          "-z",
          "--",
          "apps",
          "scripts",
          "tests",
          "docs",
          "deploy",
          "README.md",
          "package.json",
          "package-lock.json",
          ".dockerignore",
        ],
        source,
        process.env,
        true,
      )
    )
      .split("\0")
      .filter(Boolean);
  }
  await mkdir(stage);
  for (const path of sourceFiles ?? [
    "apps",
    "scripts",
    "tests",
    "docs",
    "deploy",
    "README.md",
    "package.json",
    "package-lock.json",
    ".dockerignore",
  ]) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await cp(join(source, path), join(stage, path), { recursive: true });
  }
  await mkdir(join(stage, "vendor"));
  const workspace = new Map();
  for (const directory of await readdir(join(repo, "packages"))) {
    const path = join(repo, "packages", directory);
    try {
      const manifest = await json(join(path, "package.json"));
      workspace.set(manifest.name, { path, manifest });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const needed = new Set();
  function visit(name) {
    if (needed.has(name)) return;
    const item = workspace.get(name);
    assert.ok(item && !item.manifest.private, `Missing public workspace dependency ${name}`);
    needed.add(name);
    for (const [dependency, range] of Object.entries(item.manifest.dependencies ?? {}))
      if (range.startsWith("workspace:")) visit(dependency);
  }
  visit("@cjhyy/code-shell-server");
  const product = await json(join(stage, "package.json"));
  const inventory = [];
  for (const name of needed) {
    const item = workspace.get(name);
    const output = await run(
      "bun",
      ["pm", "pack", "--ignore-scripts", "--destination", join(stage, "vendor"), "--quiet"],
      item.path,
      process.env,
      true,
    );
    const file = basename(output.split(/\r?\n/).at(-1));
    assert.match(file, /^[a-zA-Z0-9._-]+\.tgz$/);
    product.dependencies[name] = `file:vendor/${file}`;
    inventory.push({
      name,
      version: item.manifest.version,
      file,
      sha256: createHash("sha256")
        .update(await readFile(join(stage, "vendor", file)))
        .digest("hex"),
    });
  }
  await writeFile(join(stage, "package.json"), JSON.stringify(product, null, 2) + "\n");
  await run(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    stage,
  );
  // Reinstall after relocation: absolute paths and source checkout dependencies must not work.
  await rename(stage, installed);
  await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], installed);
  for (const name of needed) {
    const path = join(installed, "node_modules", name);
    assert.equal(
      await realpath(path),
      (await realpath(installed)) + `/node_modules/${name}`,
      `${name} must be installed bytes, not a workspace link`,
    );
    const manifest = await json(join(path, "package.json"));
    assert.equal(manifest.version, workspace.get(name).manifest.version);
    for (const range of Object.values(manifest.dependencies ?? {}))
      assert.ok(
        !range.startsWith("workspace:") && !range.startsWith("file:"),
        "Packed dependency must use its release version",
      );
  }
  const lock = await json(join(installed, "package-lock.json"));
  for (const [path, item] of Object.entries(lock.packages)) {
    if (path.includes("node_modules/@cjhyy/")) {
      assert.ok(!item.link, `Unexpected package link: ${path}`);
      assert.ok(
        !item.resolved || item.resolved.startsWith("file:vendor/"),
        `Unexpected registry Host fallback: ${path}`,
      );
    }
  }
  await run(process.execPath, ["scripts/check-cloud-runtime.mjs"], installed);
  if (panelsArg) {
    panelInventory = JSON.parse(
      await run(
        process.execPath,
        ["scripts/stage-candidate-panels.mjs", panelsArg, join(installed, "panels")],
        installed,
        process.env,
        true,
      ),
    );
    if (provenance) provenance.panels = panelInventory.revision;
    console.log(
      `✓ Six committed Panel packages preflighted by the independently installed Host: ${panelInventory.revision}`,
    );
  }
  await run(
    process.execPath,
    [
      join(repo, "scripts/smoke-settings-recovery.mjs"),
      join(installed, "node_modules/@cjhyy/code-shell-server"),
    ],
    installed,
  );
  // A green dependency inventory is insufficient: exercise broken deployed layouts.
  const check = () =>
    run(process.execPath, ["scripts/check-cloud-runtime.mjs"], installed, process.env, true);
  const nested = join(
    installed,
    "node_modules/@cjhyy/code-shell-server/node_modules/@cjhyy/code-shell-link",
  );
  await mkdir(dirname(nested), { recursive: true });
  await cp(join(installed, "node_modules/@cjhyy/code-shell-link"), nested, { recursive: true });
  try {
    const manifest = await json(join(nested, "package.json"));
    manifest.version = "0.0.0-incompatible";
    await writeFile(join(nested, "package.json"), JSON.stringify(manifest));
    await assert.rejects(check(), /different nested version/);
  } finally {
    await rm(nested, { recursive: true, force: true });
  }
  const webEntry = join(installed, "node_modules/@cjhyy/code-shell-web/dist-app/index.html");
  await rename(webEntry, webEntry + ".missing");
  try {
    await assert.rejects(check(), /missing Web, worker, or coding assets/);
  } finally {
    await rename(webEntry + ".missing", webEntry);
  }
  await check();
  await run("npm", ["test"], installed);
  await run("npm", ["run", "test:browser"], installed);
  if (docker) {
    const idFile = join(root, "runtime-image.id");
    await run(
      "docker",
      ["build", "--iidfile", idFile, "-f", "deploy/Dockerfile.project-runtime", "."],
      installed,
    );
    imageId = (await readFile(idFile, "utf8")).trim();
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    // The command must exist in the production image, without TUI, a network,
    // a running project or a writable root. Only this temporary fixture is written.
    await run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--no-healthcheck",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=32m,mode=1777",
        "-i",
        "--entrypoint",
        "node",
        imageId,
        "--input-type=module",
        "-",
        "/opt/codeshell/node_modules/@cjhyy/code-shell-server",
      ],
      installed,
      process.env,
      false,
      await readFile(join(repo, "scripts/smoke-settings-recovery.mjs"), "utf8"),
    );
    const tag = `codeshell-services-smoke:${basename(root).toLowerCase()}`;
    await run("docker", ["tag", imageId, tag], installed);
    try {
      await run(
        process.execPath,
        [
          join(repo, "scripts/smoke-project-sandboxes.mjs"),
          outputArg ? imageId : tag,
          ...(panelInventory ? ["--candidate-panels", join(installed, "panels")] : []),
        ],
        repo,
        {
          ...process.env,
          CODESHELL_SMOKE_INSTALLATION: installed,
        },
      );
      if (outputArg) {
        const archive = join(root, "runtime.tar");
        const platform = await run(
          "docker",
          ["image", "inspect", imageId, "--format", "{{.Os}}/{{.Architecture}}"],
          installed,
          process.env,
          true,
        );
        await run("docker", ["save", "--output", archive, imageId], installed);
        images.push({ role: "runtime", id: imageId, platform, archive });
      }
    } finally {
      await run("docker", ["image", "rm", tag], installed);
    }
    if (outputArg) {
      const linkIdFile = join(root, "link-image.id");
      await run(
        "docker",
        ["build", "--iidfile", linkIdFile, "-f", "deploy/Dockerfile.link", "."],
        installed,
      );
      const linkId = (await readFile(linkIdFile, "utf8")).trim();
      assert.match(linkId, /^sha256:[a-f0-9]{64}$/);
      await run(process.execPath, ["scripts/smoke-link-container.mjs", linkId], installed);
      const archive = join(root, "link.tar");
      const platform = await run(
        "docker",
        ["image", "inspect", linkId, "--format", "{{.Os}}/{{.Architecture}}"],
        installed,
        process.env,
        true,
      );
      await run("docker", ["save", "--output", archive, linkId], installed);
      images.push({ role: "link", id: linkId, platform, archive });
    }
  }
  if (outputArg) {
    for (const [name, path] of [
      ["host", repo],
      ["services", source],
    ]) {
      assert.equal(
        await run("git", ["status", "--porcelain"], path, process.env, true),
        "",
        `${name} changed during verification`,
      );
      assert.equal(
        await run("git", ["rev-parse", "HEAD"], path, process.env, true),
        provenance[name],
        `${name} commit changed during verification`,
      );
    }
    const { exportCandidate } = await import(
      pathToFileURL(join(installed, "scripts/lib/candidate-bundle.mjs")).href
    );
    await exportCandidate({
      installation: installed,
      output: resolve(outputArg),
      sourceFiles,
      sources: provenance,
      packages: inventory,
      images,
      panels: panelInventory?.panels,
    });
    if (panelInventory)
      await run(
        process.execPath,
        ["scripts/verify-candidate-panels.mjs", resolve(outputArg)],
        installed,
      );
    console.log(`Verified private candidate saved: ${resolve(outputArg)}`);
  }
  console.log(
    `✓ Independent services installation: ${inventory.length} real tarballs, relocated npm ci, release capability gate, complete service tests and browser OAuth${imageId ? ", packaged runtime image and two real project containers" : ""}.`,
  );
  console.log(
    JSON.stringify({ candidateOnly: true, packages: inventory, runtimeImage: imageId ?? null }),
  );
  console.log(
    "Candidate verification only; no registry release, provider acceptance or production deployment occurred.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
