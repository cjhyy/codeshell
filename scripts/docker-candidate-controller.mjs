// Test-only interception around the unmodified production Docker provider.
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateFile, candidateHash } from "./docker-candidate-guard.mjs";
import {
  candidateInspection,
  candidateMissingContainer,
  candidateProjectNames,
  createCandidateDockerAdapter,
} from "./docker-candidate-adapter.mjs";
import {
  candidateFirewallHelperArguments,
  candidateFirewallRules,
} from "./docker-candidate-netns.mjs";

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const deny = () => {
  throw new Error("Docker candidate controller custody refused");
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const runtimeMount = "/run/codeshell-candidate";
export const candidateRuntimeModules = Object.freeze([
  "docker-candidate-preload.mjs",
  "docker-candidate-guard.mjs",
  "docker-candidate-barrier.mjs",
  "docker-candidate-runtime-child.mjs",
  "docker-candidate-ack-writer.mjs",
  "docker-candidate-native-argv.mjs",
  "docker-candidate-video-argv.mjs",
]);

export function createCandidateController(config) {
  const configured = config.controller;
  if (!configured || !/^sha256:[a-f0-9]{64}$/.test(configured.helperImageId)) deny();
  const policy = { ...configured, installationId: undefined };
  const runtimePolicies = new Map();
  const projects = () => {
    let registry;
    try {
      registry = JSON.parse(
        candidateFile(join(configured.dataDir, "project-control/registry.json"), {
          maximum: 4 * 1024 * 1024,
          privateFile: true,
        }).bytes,
      );
    } catch (error) {
      if (error.code === "ENOENT" && !policy.installationId) return [];
      throw error;
    }
    if (
      !UUID.test(registry.installationId) ||
      !Array.isArray(registry.projects) ||
      registry.projects.length > 100 ||
      (policy.installationId && policy.installationId !== registry.installationId)
    )
      deny();
    policy.installationId = registry.installationId;
    return registry.projects.map(({ id, ownerId, generation }) => {
      const project = { id, ownerId, generation };
      candidateProjectNames(policy.installationId, project);
      return project;
    });
  };
  const rewriteCreate = (args, operation) => {
    const directory = join(
      config.home,
      ".candidate",
      `runtime-${operation.project.id}-${operation.project.generation}`,
    );
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    chmodSync(directory, 0o755);
    const moduleHashes = {};
    for (const name of candidateRuntimeModules) {
      const source = join(moduleRoot, name);
      const actual = candidateFile(source).sha256;
      if (actual !== configured.moduleHashes?.[name]) deny();
      copyFileSync(source, join(directory, name));
      chmodSync(join(directory, name), 0o444);
      moduleHashes[name] = actual;
    }
    const runtime = {
      version: 1,
      role: "runtime",
      home: "/data/home",
      dataRoot: "/data",
      receipt: "/data/home/.candidate/guard.jsonl",
      preload: `${runtimeMount}/docker-candidate-preload.mjs`,
      preloadHash: moduleHashes["docker-candidate-preload.mjs"],
      guardHash: moduleHashes["docker-candidate-guard.mjs"],
      origins: [18791, 18792, 18793, 18794].map((port) => `http://127.0.0.1:${port}`),
      listenerAliases: configured.videoEditorHash
        ? [
            {
              entryHash: configured.videoEditorHash,
              host: "127.0.0.1",
              requestedPort: 0,
              port: 18794,
            },
          ]
        : [],
      listeners: [
        { host: "0.0.0.0", port: 8790 },
        ...[18791, 18793].map((port) => ({ host: "127.0.0.1", port })),
      ],
      children: [],
      runtime: {
        entry: "/opt/codeshell/packages/server/dist/bin/code-shell-project-runtime.js",
        workerEntry: configured.containerCore.replace(/\/index\.js$/, "/cli/agent-server-stdio.js"),
        projectId: operation.project.id,
        nonce: randomBytes(16).toString("hex"),
        imageId: configured.imageId,
        entryHashes: configured.entryHashes,
        inlinePrograms: configured.inlinePrograms,
        nativePrograms: configured.nativePrograms,
        moduleHashes,
      },
    };
    if (runtime.runtime.workerEntry === configured.containerCore) deny();
    const bytes = JSON.stringify(runtime) + "\n";
    const hash = candidateHash(bytes);
    writeFileSync(join(directory, "runtime-policy.json"), bytes, { mode: 0o444, flag: "wx" });
    runtimePolicies.set(operation.target, { runtime, hash, directory });
    const image = args.indexOf(configured.image);
    if (image < 0 || /[,\r\n]/.test(directory)) deny();
    return [
      ...args.slice(0, image),
      "--mount",
      `type=bind,source=${directory},target=${runtimeMount},readonly`,
      "--env",
      "USERPROFILE=/data/home",
      "--env",
      `NODE_OPTIONS=--import=${runtime.preload}`,
      "--env",
      "CODESHELL_DOCKER_CANDIDATE_CONTAINER=1",
      "--env",
      `CODESHELL_DOCKER_CANDIDATE_CONFIG=${runtimeMount}/runtime-policy.json`,
      "--env",
      `CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH=${hash}`,
      ...args.slice(image),
    ];
  };
  const afterStart = async (operation, custody) => {
    const pinned = runtimePolicies.get(operation.target);
    if (!pinned || !custody) deny();
    const { runtime, hash: policyHash } = pinned;
    const run = (args, input, timeout = 10000, cleanup = false) =>
      new Promise((resolve, reject) => {
        if (!cleanup) custody.signal?.throwIfAborted();
        if (
          candidateFile(configured.dockerPath, { maximum: 128 * 1024 * 1024 }).sha256 !==
          configured.dockerHash
        )
          deny();
        const child = custody.original(
          configured.dockerPath,
          args,
          {
            encoding: "utf8",
            timeout,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
            ...(!cleanup && custody.signal ? { signal: custody.signal } : {}),
          },
          (error, stdout, stderr) =>
            error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
        );
        custody.record("docker-child", { childPid: child.pid, internal: true });
        child.stdin?.on("error", () => {});
        child.stdin?.end(input);
      });
    const inspect = async () => {
      const output = await run(["container", "inspect", operation.target]);
      const pin = candidateInspection(
        policy,
        { ...operation, kind: "inspect", resource: "container" },
        output,
      );
      if (!pin.id || !pin.origin) deny();
      return pin;
    };
    const actual = await inspect();
    let boot;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        boot = JSON.parse(
          await run(
            ["exec", actual.id, "/bin/cat", "/data/home/.candidate/boot.json"],
            undefined,
            2000,
          ),
        );
      } catch {
        custody.signal?.throwIfAborted();
        await sleep(50);
        continue;
      }
      if (
        boot.version !== 1 ||
        boot.state !== "waiting" ||
        boot.policyHash !== policyHash ||
        !/^[a-f0-9]{32}$/.test(boot.bootNonce) ||
        !/^net:\[[0-9]+\]$/.test(boot.netns)
      )
        deny();
      break;
    }
    if (!boot) throw new Error("Docker candidate runtime did not reach its pre-Core barrier");
    const name = `candidate-helper-${policy.installationId}-${operation.project.id}-${randomBytes(6).toString("hex")}`;
    const helperPolicy = {
      version: 1,
      containerId: actual.id,
      projectId: operation.project.id,
      nonce: runtime.runtime.nonce,
      bootNonce: boot.bootNonce,
      policyHash,
      netns: boot.netns,
    };
    let failed = false,
      primary,
      receipt;
    const cleanupErrors = [];
    try {
      custody.record("helper-starting", {
        name,
        containerId: actual.id,
        helperImageId: configured.helperImageId,
      });
      const output = await run(
        candidateFirewallHelperArguments({
          imageId: configured.helperImageId,
          containerId: actual.id,
          name,
          installationId: policy.installationId,
          dataVolume: candidateProjectNames(policy.installationId, operation.project).data,
          policy: helperPolicy,
        }),
      );
      receipt = JSON.parse(output);
      for (const [key, value] of Object.entries(helperPolicy)) if (receipt[key] !== value) deny();
      if (
        receipt.nativeEgress !== "ipv4-ipv6-output-default-deny" ||
        receipt.preCore !== true ||
        receipt.nativeNegativeProbes?.length !== 2 ||
        receipt.nativeNegativeProbes.some(
          (entry, index) =>
            entry.family !== [4, 6][index] ||
            !["deadline", "ENETUNREACH", "EHOSTUNREACH"].includes(entry.result),
        ) ||
        receipt.receipts?.length !== 2 ||
        receipt.receipts.some(
          (entry, index) =>
            entry.family !== [4, 6][index] ||
            entry.rulesHash !== candidateHash(candidateFirewallRules([4, 6][index])),
        )
      )
        deny();
      const inventory = receipt.inventory;
      if (
        inventory?.base !==
          "sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9" ||
        inventory.snapshot !== "20250301T000000Z" ||
        typeof inventory.packages !== "string" ||
        !inventory.packages.split("\n").includes("iptables=1.8.9-2") ||
        !Array.isArray(inventory.files) ||
        inventory.files.length !== 6 ||
        inventory.files.some((file) => !/^[a-f0-9]{64}$/.test(file.sha256))
      )
        deny();
      for (const [path, expected] of [
        ["/docker-candidate-netns.mjs", configured.moduleHashes["docker-candidate-netns.mjs"]],
        [
          "/helper/docker-candidate-netns-entry.mjs",
          configured.helperInputHashes["fixtures/docker-candidate-netns-entry.mjs"],
        ],
      ])
        if (inventory.files.find((file) => file.path === path)?.sha256 !== expected) deny();
      writeFileSync(
        join(config.home, ".candidate", `helper-${actual.id}.json`),
        JSON.stringify({ imageId: configured.helperImageId, ...receipt }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      const current = await inspect();
      if (current.id !== actual.id || current.origin !== actual.origin) deny();
      custody.signal?.throwIfAborted();
      const published = JSON.parse(
        await run([
          "exec",
          actual.id,
          "node",
          `${runtimeMount}/docker-candidate-ack-writer.mjs`,
          Buffer.from(JSON.stringify(receipt)).toString("base64url"),
        ]),
      );
      if (
        published.ackPublished !== true ||
        published.bootNonce !== boot.bootNonce ||
        published.containerId !== actual.id
      )
        deny();
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      // --rm success is checked too. On a lost run response inspect only this
      // random name, verify immutable image and both custody labels, then remove.
      let resource;
      try {
        resource = JSON.parse(await run(["container", "inspect", name], undefined, 5000, true))[0];
      } catch (error) {
        if (!candidateMissingContainer(error, name)) cleanupErrors.push(error);
      }
      if (resource) {
        try {
          if (
            resource.Image !== configured.helperImageId ||
            resource.Name !== `/${name}` ||
            resource.Config?.Labels?.["io.codeshell.candidate-helper.installation"] !==
              policy.installationId ||
            resource.Config?.Labels?.["io.codeshell.candidate-helper.target"] !== actual.id ||
            !/^[a-f0-9]{64}$/.test(resource.Id)
          )
            deny();
          await run(["container", "rm", "-f", resource.Id], undefined, 5000, true);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        [...(failed ? [primary] : []), ...cleanupErrors],
        "Docker candidate helper cleanup failed",
        failed ? { cause: primary } : undefined,
      );
    if (failed) throw primary;
    custody.signal?.throwIfAborted();
    return receipt;
  };
  const adapter = createCandidateDockerAdapter(policy, { projects, rewriteCreate, afterStart });
  return adapter;
}
