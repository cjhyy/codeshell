import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { candidateHash } from "../scripts/docker-candidate-guard.mjs";
import {
  pinCandidateStockWebSocket,
  loadCandidateStockWebSocket,
} from "../scripts/docker-candidate-stock-ws.mjs";

const root = resolve(import.meta.dir, "..");
const node = realpathSync(Bun.which("node")!);
const pin = pinCandidateStockWebSocket(join(root, "packages/server/package.json"));

async function actual(mode: string, change: (config: any) => void = () => {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "candidate-stock-ws-")));
  chmodSync(home, 0o700);
  const bundle = join(home, "bundle");
  mkdirSync(bundle, { mode: 0o700 });
  const names = [
    "docker-candidate-guard.mjs",
    "docker-candidate-preload.mjs",
    "docker-candidate-stock-ws.mjs",
    "docker-candidate-controller.mjs",
    "docker-candidate-adapter.mjs",
    "docker-candidate-netns.mjs",
  ];
  const hashes: Record<string, string> = {};
  for (const name of names) {
    copyFileSync(join(root, "scripts", name), join(bundle, name));
    hashes[name] = candidateHash(readFileSync(join(bundle, name)));
  }
  const preload = join(bundle, "docker-candidate-preload.mjs");
  const policyPath = join(home, "policy.json");
  const receipt = join(home, "receipt.jsonl");
  const config: any = {
    version: 1,
    role: mode === "preload" ? "controller" : "driver",
    home,
    dataRoot: home,
    preload,
    preloadHash: hashes["docker-candidate-preload.mjs"],
    guardHash: hashes["docker-candidate-guard.mjs"],
    receipt,
    listeners: [{ host: "127.0.0.1", port: 0 }],
    origins: [],
    children: [],
    stockWebSocket: pin,
    controller: {
      moduleHashes: hashes,
      helperImageId: `sha256:${"b".repeat(64)}`,
      dockerHash: "a".repeat(64),
      imageId: `sha256:${"a".repeat(64)}`,
    },
  };
  change(config);
  writeFileSync(policyPath, JSON.stringify(config), { mode: 0o600 });
  const env = {
    HOME: home,
    USERPROFILE: home,
    CODE_SHELL_HOME: join(home, ".code-shell"),
    PATH: dirname(node),
    NODE_OPTIONS: `--import=${preload}`,
    CODESHELL_DOCKER_CANDIDATE_CONFIG: policyPath,
    CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH: candidateHash(readFileSync(policyPath)),
  };
  let child,
    closed = false;
  try {
    // Manual mode sets NODE_OPTIONS only inside entry to avoid automatically
    // installing the preload; the initialized guard still checks its exact value.
    child = spawn(
      node,
      [
        join(
          root,
          `tests/fixtures/docker-candidate-stock-ws-${mode === "cached" ? "cached-" : ""}case.mjs`,
        ),
        mode,
      ],
      {
        env: mode === "preload" ? env : { ...env, NODE_OPTIONS: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => (stdout += bytes));
    child.stderr.on("data", (bytes) => (stderr += bytes));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    const [code, signal] = await once(child, "close").finally(() => clearTimeout(timer));
    closed = true;
    return {
      code,
      signal,
      stdout,
      stderr,
      rows: readFileSync(receipt, "utf8").trim().split("\n").map(JSON.parse),
    };
  } finally {
    if (child && !closed) {
      child.kill("SIGKILL");
      await once(child, "close");
      closed = true;
    }
    if (!child || closed) rmSync(home, { recursive: true, force: true });
  }
}

test("actual Node stock ws handshake runs after 6+4 guards; foreign hooks stay uncalled", async () => {
  const value = await actual("manual");
  expect(value.stderr).toBe("");
  expect(value.code).toBe(0);
  expect(value.signal).toBeNull();
  expect(JSON.parse(value.stdout.trim())).toMatchObject({
    passed: true,
    loaderCalls: 1,
    upgrades: 2,
    customCalls: 0,
    sockets: 0,
    listenersClosed: true,
    esmConstructorIdentical: true,
  });
  expect(value.rows[0]).toMatchObject({
    event: "pre-core",
    negativeProbes: 6,
    dnsNegativeProbes: 4,
  });
  expect(value.rows[1]).toMatchObject({
    event: "stock-websocket-ready",
    nativeRequestDelegations: 0,
    observations: 1,
  });
});
test("controller's actual preload and production ws ESM entry share the observed connector", async () => {
  const value = await actual("preload");
  expect(value.stderr).toBe("");
  expect(value.code).toBe(0);
  expect(value.signal).toBeNull();
  expect(JSON.parse(value.stdout.trim())).toMatchObject({
    passed: true,
    role: "controller",
    upgrades: 2,
    customCalls: 0,
    sockets: 0,
    listenersClosed: true,
    esmConstructorIdentical: true,
  });
  expect(value.rows[1]).toMatchObject({
    event: "stock-websocket-ready",
    nativeRequestDelegations: 0,
  });
});
test("reviewed complete source pin rejects unknown patches, extra fields and changed digests", () => {
  expect(pin.packageVersion).toBe("8.21.0");
  for (const changed of [
    { ...pin, packageVersion: "8.21.99" },
    { ...pin, sourceHash: "a".repeat(64) },
    { ...pin, constructor: () => {} },
    { ...pin, packageVersion: "__proto__" },
  ])
    expect(() => loadCandidateStockWebSocket(changed)).toThrow("stock WebSocket source refused");
});

test("actual Node connector cuts reject revoke, reuse and target/hooks mutation before native TCP", async () => {
  const value = await actual("cuts");
  expect(value.stderr).toBe("");
  expect(value.code).toBe(0);
  expect(value.signal).toBeNull();
  expect(JSON.parse(value.stdout.trim())).toMatchObject({
    passed: true,
    loaderCalls: 1,
    upgrades: 0,
    customCalls: 0,
    sockets: 0,
    listenersClosed: true,
  });
});

test("actual Node refuses cached fake constructor before first load without invoking it", async () => {
  const value = await actual("cached");
  expect(value.stderr).toBe("");
  expect(value.code).toBe(0);
  expect(value.signal).toBeNull();
  expect(JSON.parse(value.stdout.trim())).toMatchObject({
    passed: true,
    fakeCalls: 0,
    nativeRequests: 0,
    loaderCalls: 1,
  });
  expect(value.rows).toHaveLength(1);
  expect(value.rows[0]).toMatchObject({
    event: "pre-core",
    negativeProbes: 6,
    dnsNegativeProbes: 4,
  });
});
