import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { candidateFile, candidateHash } from "../scripts/docker-candidate-guard.mjs";
import {
  candidateCreateArguments,
  candidateProjectNames,
} from "../scripts/docker-candidate-adapter.mjs";
import {
  candidateRuntimeModules,
  createCandidateController,
} from "../scripts/docker-candidate-controller.mjs";
import { candidateFirewallRules } from "../scripts/docker-candidate-netns.mjs";
const root = resolve(import.meta.dir, "..");
const node = realpathSync(Bun.which("node")!);
const installationId = "7fd72c35-cf18-498b-9bb7-f06705d59cca";
const project = {
  id: "a1de6837-ce16-4d5c-a320-180b9cb38b58",
  ownerId: "fixture-owner",
  generation: 1,
};
const containerId = "c".repeat(64);

// A controlled Docker CLI adapter, never a real Docker/kernel acceptance claim.
function fixture(cut: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "candidate-controller-")));
  chmodSync(home, 0o700);
  mkdirSync(join(home, ".candidate"), { mode: 0o700 });
  const dataDir = join(home, "data");
  mkdirSync(join(dataDir, "project-control"), { recursive: true });
  writeFileSync(
    join(dataDir, "project-control/registry.json"),
    JSON.stringify({ installationId, projects: [project] }),
    { mode: 0o600 },
  );
  const moduleHashes = Object.fromEntries(
    [
      ...candidateRuntimeModules,
      "docker-candidate-controller.mjs",
      "docker-candidate-adapter.mjs",
      "docker-candidate-netns.mjs",
    ].map((name) => [name, candidateFile(join(root, "scripts", name)).sha256]),
  );
  const policy = {
    command: "docker",
    dockerPath: node,
    dockerHash: candidateFile(node, { maximum: 128 * 1024 * 1024 }).sha256,
    image: "fixture:immutable",
    imageId: `sha256:${"a".repeat(64)}`,
    helperImageId: `sha256:${"b".repeat(64)}`,
    dataDir,
    containerCore: "/opt/codeshell/packages/core/dist/index.js",
    moduleHashes,
    entryHashes: [],
    inlinePrograms: [],
    nativePrograms: [],
    helperInputHashes: {
      "fixtures/docker-candidate-netns-entry.mjs": candidateFile(
        join(root, "scripts/fixtures/docker-candidate-netns-entry.mjs"),
      ).sha256,
    },
  };
  const controller = createCandidateController({ home, controller: policy });
  const names = candidateProjectNames(installationId, project);
  const resource = {
    Id: containerId,
    Image: policy.imageId,
    Name: `/${names.container}`,
    State: { Running: true },
    Config: {
      Labels: {
        "io.codeshell.project-runtime.installation": installationId,
        "io.codeshell.project-runtime.project": project.id,
        "io.codeshell.project-runtime.owner": project.ownerId,
        "io.codeshell.project-runtime.generation": "1",
        "io.codeshell.project-runtime.configuration": "f".repeat(64),
      },
    },
    NetworkSettings: { Ports: { "8790/tcp": [{ HostIp: "127.0.0.1", HostPort: "32941" }] } },
  };
  const abort = new AbortController();
  const calls: { args: string[]; signal: AbortSignal | undefined }[] = [];
  let runtimeFile: string, helperPolicy: any;
  let releaseHelper: (() => void) | undefined;
  const helperEntered = new Promise<void>((resolveEntered) => {
    releaseHelper = () => resolveEntered();
  });
  let announceHelper: (() => void) | undefined;
  const helperReady = new Promise<void>((resolveReady) => {
    announceHelper = resolveReady;
  });
  const original = (_command, args, options, callback) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 100 + calls.length,
      stdin: new PassThrough(),
    });
    calls.push({ args, signal: options.signal });
    void (async () => {
      let output = "",
        failure: any,
        stderr = "";
      if (args[1] === "create") {
        const mount = args.find(
          (arg) => arg.startsWith("type=bind,") && arg.includes("target=/run/codeshell-candidate"),
        );
        runtimeFile = join(mount.match(/source=([^,]+)/)![1], "runtime-policy.json");
      } else if (args[0] === "run") {
        helperPolicy = JSON.parse(Buffer.from(args.at(-1), "base64url").toString());
        const inventory = {
          base: "sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9",
          snapshot: "20250301T000000Z",
          packages: "iptables=1.8.9-2\n",
          files: [
            "/usr/sbin/iptables",
            "/usr/sbin/ip6tables",
            "/usr/sbin/iptables-restore",
            "/usr/sbin/ip6tables-restore",
            "/docker-candidate-netns.mjs",
            "/helper/docker-candidate-netns-entry.mjs",
          ].map((path) => ({
            path,
            sha256:
              path === "/docker-candidate-netns.mjs"
                ? moduleHashes["docker-candidate-netns.mjs"]
                : path.startsWith("/helper/")
                  ? policy.helperInputHashes["fixtures/docker-candidate-netns-entry.mjs"]
                  : "e".repeat(64),
          })),
        };
        if (cut === "concurrent custody") {
          announceHelper!();
          await helperEntered;
        }
        if (cut === "abort after helper") abort.abort(new Error("cancelled fixture start"));
        output = JSON.stringify({
          ...helperPolicy,
          netns: cut === "wrong namespace" ? "net:[456]" : helperPolicy.netns,
          nativeEgress: "ipv4-ipv6-output-default-deny",
          preCore: true,
          nativeNegativeProbes: [4, 6].map((family) => ({ family, result: "deadline" })),
          receipts: [4, 6].map((family) => ({
            family,
            rulesHash: candidateHash(candidateFirewallRules(family)),
          })),
          inventory,
        });
      } else if (args[0] === "exec" && args[2] === "/bin/cat") {
        output = JSON.stringify({
          version: 1,
          state: "waiting",
          policyHash: candidateFile(runtimeFile).sha256,
          bootNonce: "d".repeat(32),
          netns: "net:[123]",
        });
      } else if (args[0] === "exec")
        output = JSON.stringify({
          ackPublished: true,
          bootNonce: helperPolicy.bootNonce,
          containerId,
        });
      else if (args[0] === "container" && args[1] === "inspect") {
        if (args[2] === names.container) output = JSON.stringify([resource]);
        else {
          failure = Object.assign(new Error("controlled cleanup inspect failure"), { code: 1 });
          stderr =
            cut === "cleanup failure"
              ? "daemon unavailable"
              : cut === "unrelated not found"
                ? "daemon context not found"
                : `Error response from daemon: No such container: ${args[2]}`;
          if (cut === "abort during cleanup")
            abort.abort(new Error("cancelled during helper cleanup"));
        }
      }
      child.emit("close", failure ? 1 : 0, null);
      callback(failure, output, stderr);
    })().catch((error) => callback(error, "", "controlled adapter failure"));
    return child;
  };
  const call = (args, originalCall = original, signal?: AbortSignal) =>
    new Promise((resolveCall, reject) =>
      controller({
        command: "docker",
        args,
        options: signal ? { signal } : {},
        callback: (error, stdout) => (error ? reject(error) : resolveCall(stdout)),
        original: originalCall,
        allowOrigin() {},
        record() {},
      }),
    );
  return {
    home,
    calls,
    abort,
    original,
    call,
    helperReady,
    releaseHelper: () => releaseHelper!(),
    async create() {
      await call(candidateCreateArguments({ ...policy, installationId }, project, "f".repeat(64)));
    },
    start() {
      return call(["container", "start", names.container], original, abort.signal);
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("controlled helper validates both rule hashes and exact boot, then writes ACK and checks --rm", async () => {
  const value = fixture("success");
  try {
    await value.create();
    await value.start();
    expect(value.calls.some(({ args }) => args[0] === "exec" && args[2] === "node")).toBe(true);
    expect(value.calls.at(-1)!.args.slice(0, 2)).toEqual(["container", "inspect"]);
  } finally {
    value.cleanup();
  }
});
for (const cut of [
  "wrong namespace",
  "abort after helper",
  "cleanup failure",
  "unrelated not found",
  "abort during cleanup",
])
  test(`controlled ${cut} does not become a successful start`, async () => {
    const value = fixture(cut);
    try {
      await value.create();
      await expect(value.start()).rejects.toThrow();
      if (["wrong namespace", "abort after helper"].includes(cut))
        expect(value.calls.some(({ args }) => args[0] === "exec" && args[2] === "node")).toBe(
          false,
        );
      const cleanup = value.calls.at(-1)!;
      expect(cleanup.args.slice(0, 2)).toEqual(["container", "inspect"]);
      expect(cleanup.signal).toBeUndefined();
      if (cut === "abort after helper")
        expect(value.calls.filter(({ args }) => args[0] === "run")[0].signal).toBe(
          value.abort.signal,
        );
    } finally {
      value.cleanup();
    }
  });
test("a later request cannot replace an in-flight start's original Docker/abort custody", async () => {
  const value = fixture("concurrent custody");
  try {
    await value.create();
    const pending = value.start();
    await value.helperReady;
    let foreignCalls = 0;
    const foreign = (_command, _args, _options, callback) => {
      foreignCalls++;
      queueMicrotask(() => callback(null, "ok", ""));
      return { pid: 999 };
    };
    await value.call(["info", "--format", "{{json .ServerVersion}}"], foreign);
    value.releaseHelper();
    await pending;
    expect(foreignCalls).toBe(1);
    expect(value.calls.some(({ args }) => args[0] === "exec" && args[2] === "node")).toBe(true);
  } finally {
    value.cleanup();
  }
});
