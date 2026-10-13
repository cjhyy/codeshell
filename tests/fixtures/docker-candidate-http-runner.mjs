// Captured actual Node fixture; no Core, provider or browser is loaded here.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { candidateHash, candidateFile } from "../../scripts/docker-candidate-guard.mjs";
import { createTestStockWebSocketPackage } from "./docker-candidate-stock-ws-package.mjs";

export async function runCandidateHttpFixture(node, mode, evidence, browserCache) {
  const root = resolve(import.meta.dirname, "../..");
  const ws = createTestStockWebSocketPackage(join(root, "packages/server/package.json"));
  const home = ws.root,
    bundle = join(home, "bundle"),
    temporaryRoot = join(home, "tmp");
  mkdirSync(bundle, { mode: 0o700 });
  mkdirSync(temporaryRoot, { mode: 0o700 });
  const hashes = {};
  for (const name of ["guard", "preload", "stock-ws", "controller", "adapter", "netns"]) {
    const file = `docker-candidate-${name}.mjs`;
    copyFileSync(join(root, "scripts", file), join(bundle, file));
    hashes[file] = candidateHash(readFileSync(join(bundle, file)));
  }
  const preload = join(bundle, "docker-candidate-preload.mjs");
  const config = {
    version: 1,
    role: mode === "native" ? "installer" : "driver",
    home,
    dataRoot: home,
    preload,
    preloadHash: hashes["docker-candidate-preload.mjs"],
    guardHash: hashes["docker-candidate-guard.mjs"],
    receipt: join(home, "guard.jsonl"),
    listeners: mode === "native" ? [{ host: "127.0.0.1", port: 0 }] : [],
    origins: [],
    children: [],
    stockWebSocket: ws.pin,
    fixtureRoot: root,
    temporaryRoot,
    moduleHashes: hashes,
  };
  if (mode === "chromium") {
    const serverHome = join(home, "controller");
    mkdirSync(serverHome, { mode: 0o700 });
    const serverPolicy = {
      ...config,
      role: "controller",
      home: serverHome,
      dataRoot: serverHome,
      listeners: [{ host: "127.0.0.1", port: 0 }],
      receipt: join(serverHome, "guard.jsonl"),
      controller: {
        moduleHashes: hashes,
        helperImageId: `sha256:${"b".repeat(64)}`,
        dockerHash: "a".repeat(64),
        imageId: `sha256:${"a".repeat(64)}`,
      },
    };
    const path = join(serverHome, "policy.json");
    writeFileSync(path, JSON.stringify(serverPolicy), { mode: 0o600 });
    const environment = {
      HOME: serverHome,
      USERPROFILE: serverHome,
      CODE_SHELL_HOME: join(serverHome, ".code-shell"),
      NODE_OPTIONS: `--import=${preload}`,
      CODESHELL_DOCKER_CANDIDATE_CONFIG: path,
      CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH: candidateHash(readFileSync(path)),
    };
    const args = [join(root, "tests/fixtures/docker-candidate-http-case.mjs"), "server"];
    config.children.push({
      path: node,
      sha256: candidateFile(node, { maximum: 128 * 1024 * 1024 }).sha256,
      args,
      role: "controller",
      environment,
      entry: args[0],
      entryHash: candidateHash(readFileSync(args[0])),
    });
    config.server = {
      path,
      policyHash: environment.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH,
      environment,
    };
  }
  const path = join(home, "policy.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  let child,
    closed = false,
    success = false,
    stdout = "",
    stderr = "";
  try {
    child = spawn(node, [join(root, "tests/fixtures/docker-candidate-http-case.mjs"), mode], {
      env: {
        HOME: home,
        USERPROFILE: home,
        CODE_SHELL_HOME: join(home, ".code-shell"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        TMPDIR: temporaryRoot,
        PATH: dirname(node),
        NODE_OPTIONS: "",
        NODE_USE_ENV_PROXY: "0",
        NODE_NO_WARNINGS: "1",
        CODESHELL_DOCKER_CANDIDATE_CONFIG: path,
        CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH: candidateHash(readFileSync(path)),
        ...(mode === "chromium" ? { PLAYWRIGHT_BROWSERS_PATH: realpathSync(browserCache) } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), mode === "native" ? 15000 : 60000);
    const [code, signal] = await once(child, "close").finally(() => clearTimeout(timer));
    closed = true;
    const result = {
      code,
      signal,
      pid: child.pid,
      stdout,
      stderr,
      custodyRoot: home,
      guardRows: readFileSync(config.receipt, "utf8").trim().split("\n").map(JSON.parse),
      ...(config.server
        ? {
            controllerRows: readFileSync(join(home, "controller/guard.jsonl"), "utf8")
              .trim()
              .split("\n")
              .map(JSON.parse),
          }
        : {}),
    };
    success = code === 0 && signal === null && JSON.parse(stdout.trim()).passed === true;
    if (evidence) writeFileSync(evidence, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    return result;
  } finally {
    if (child && !closed) {
      child.kill("SIGKILL");
      await once(child, "close");
      closed = true;
    }
    // A failed/killed driver cannot prove its Chromium/controller custody. Keep
    // the private root for evidence instead of deleting a possibly live HOME.
    if (!child || (closed && success)) ws.dispose();
  }
}
