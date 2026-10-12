// Test-only adapter for the production provider's exact Docker CLI protocol.
// This module imports neither Server nor Core and never starts Docker on import.
import { join } from "node:path";
import { candidateFile } from "./docker-candidate-guard.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const label = "io.codeshell.project-runtime";
const refuse = () => {
  throw new Error("Docker candidate refused an unowned Docker command or receipt");
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function candidateProjectNames(installationId, project) {
  if (
    !UUID.test(installationId) ||
    !project ||
    !UUID.test(project.id) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(project.ownerId) ||
    !Number.isSafeInteger(project.generation) ||
    project.generation < 0
  )
    refuse();
  const base = `codeshell-${installationId}-${project.id}`;
  return {
    container: base,
    network: `${base}-network`,
    data: `${base}-data`,
    workspace: `${base}-workspace`,
  };
}

function labels(installationId, project) {
  return {
    [`${label}.installation`]: installationId,
    [`${label}.project`]: project.id,
    [`${label}.owner`]: project.ownerId,
  };
}

/** Frozen current production argv, including security options and mount targets. */
export function candidateCreateArguments(policy, project, configuration) {
  if (!HASH.test(configuration)) refuse();
  const names = candidateProjectNames(policy.installationId, project);
  const args = [
    "container",
    "create",
    "--name",
    names.container,
    "--init",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--memory",
    "2048m",
    "--memory-swap",
    "2048m",
    "--cpus",
    "2",
    "--pids-limit",
    "256",
    "--ulimit",
    "nofile=4096:4096",
    "--shm-size",
    "128m",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=268435456,mode=1777",
    "--network",
    names.network,
    "--publish",
    "127.0.0.1::8790",
    "--workdir",
    "/workspace",
    "--mount",
    `type=volume,source=${names.data},target=/data`,
    "--mount",
    `type=volume,source=${names.workspace},target=/workspace`,
    "--mount",
    `type=bind,source=${join(policy.dataDir, "project-runtime-secrets", project.id, "runtime.json")},target=/run/codeshell-project.json,readonly`,
    "--env",
    "HOME=/data/home",
    "--env",
    "CODE_SHELL_HOME=/data/home/.code-shell",
    "--env",
    "NPM_CONFIG_CACHE=/data/home/.npm",
    "--env",
    "NPM_CONFIG_PREFIX=/data/home/.local",
    "--env",
    "PATH=/data/panel-bin:/data/home/.local/bin:/data/home/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--env",
    "PYTHONUSERBASE=/data/home/.local",
    "--env",
    "PIP_CACHE_DIR=/data/home/.cache/pip",
    "--entrypoint",
    "node",
  ];
  if (policy.seccompPath) args.push("--security-opt", `seccomp=${policy.seccompPath}`);
  for (const [key, value] of Object.entries({
    ...labels(policy.installationId, project),
    [`${label}.generation`]: String(project.generation),
    [`${label}.configuration`]: configuration,
  }))
    args.push("--label", `${key}=${value}`);
  args.push(
    policy.image,
    "/opt/codeshell/packages/server/dist/bin/code-shell-project-runtime.js",
    "--secret",
    "/run/codeshell-project.json",
  );
  return args;
}

/** Reject additions, flag reordering, aliases and targets outside the fresh registry. */
export function validateCandidateDockerArguments(policy, projects, args) {
  if (!Array.isArray(args) || args.length > 160 || args.some((a) => typeof a !== "string"))
    refuse();
  if (same(args, ["info", "--format", "{{json .ServerVersion}}"])) return { kind: "info" };
  if (same(args, ["image", "inspect", policy.image])) return { kind: "image" };
  for (const project of projects) {
    const names = candidateProjectNames(policy.installationId, project);
    for (const kind of ["container", "network", "volume"]) {
      const targets = kind === "volume" ? [names.data, names.workspace] : [names[kind]];
      for (const target of targets) {
        if (same(args, [kind, "inspect", target]))
          return { kind: "inspect", resource: kind, project, target };
        if (kind === "container") {
          if (same(args, [kind, "start", target])) return { kind: "start", project, target };
          if (same(args, [kind, "stop", "--time", "5", target]))
            return { kind: "stop", project, target };
          if (same(args, [kind, "rm", target])) return { kind: "remove", project, target };
        } else {
          const expected = [kind, "create"];
          for (const [key, value] of Object.entries(labels(policy.installationId, project)))
            expected.push("--label", `${key}=${value}`);
          if (kind === "network")
            expected.push(
              "--driver",
              "bridge",
              "--opt",
              "com.docker.network.bridge.enable_icc=false",
            );
          expected.push(target);
          if (same(args, expected)) return { kind: "resource", resource: kind, project, target };
        }
      }
    }
    const value = args
      .find((arg) => arg.startsWith(`${label}.configuration=`))
      ?.slice(`${label}.configuration=`.length);
    if (value && same(args, candidateCreateArguments(policy, project, value)))
      return { kind: "create", project, target: names.container, configuration: value };
  }
  refuse();
}

/** A label alone cannot mint a network destination or immutable container authority. */
export function candidateInspection(policy, operation, stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]) refuse();
  const value = parsed[0];
  if (operation.kind === "image") {
    if (value.Id !== policy.imageId) refuse();
    return {};
  }
  if (operation.kind !== "inspect") return {};
  const actual = value.Config?.Labels ?? value.Labels;
  for (const [key, expected] of Object.entries(labels(policy.installationId, operation.project)))
    if (actual?.[key] !== expected) refuse();
  if (operation.resource !== "container") {
    if (value.Name !== operation.target) refuse();
    return {};
  }
  if (
    !HASH.test(value.Id) ||
    value.Name !== `/${operation.target}` ||
    value.Image !== policy.imageId ||
    actual[`${label}.generation`] !== String(operation.project.generation) ||
    !HASH.test(actual[`${label}.configuration`])
  )
    refuse();
  const binding = value.NetworkSettings?.Ports?.["8790/tcp"];
  // A created/stopped container need not have an allocated published port yet.
  if (!value.State?.Running) return { id: value.Id };
  if (
    !Array.isArray(binding) ||
    binding.length !== 1 ||
    binding[0].HostIp !== "127.0.0.1" ||
    !/^[0-9]{1,5}$/.test(binding[0].HostPort) ||
    +binding[0].HostPort < 1 ||
    +binding[0].HostPort > 65535
  )
    refuse();
  return { id: value.Id, origin: `http://127.0.0.1:${binding[0].HostPort}` };
}

/** Only the captured native execFile can run the pinned Docker binary. */
export function createCandidateDockerAdapter(policy, { projects, afterStart, rewriteCreate } = {}) {
  if (!HASH.test(policy.dockerHash) || !/^sha256:[a-f0-9]{64}$/.test(policy.imageId)) refuse();
  return ({ command, args, options = {}, callback, original, allowOrigin, record }) => {
    if (
      command !== policy.command ||
      options.shell ||
      options.detached ||
      options.env ||
      typeof callback !== "function" ||
      candidateFile(policy.dockerPath, { maximum: 128 * 1024 * 1024 }).sha256 !== policy.dockerHash
    )
      refuse();
    const operation = validateCandidateDockerArguments(policy, projects(), args);
    if (operation.kind === "start" && typeof afterStart !== "function") refuse();
    const actual = operation.kind === "create" ? rewriteCreate?.(args, operation) : args;
    if (!actual || !Array.isArray(actual)) refuse();
    record("docker-command", { operation: operation.kind, projectId: operation.project?.id });
    const child = original(policy.dockerPath, actual, options, (error, stdout, stderr) => {
      void (async () => {
        if (error) {
          callback(error, stdout, stderr);
          return;
        }
        if (["inspect", "image"].includes(operation.kind)) {
          const inspection = candidateInspection(policy, operation, stdout);
          if (inspection.origin) allowOrigin(inspection.origin);
        }
        if (operation.kind === "start") {
          const ack = await afterStart(operation);
          if (
            ack?.version !== 1 ||
            ack.projectId !== operation.project.id ||
            ack.nativeEgress !== "ipv4-ipv6-output-default-deny" ||
            !HASH.test(ack.containerId) ||
            ack.preCore !== true
          )
            refuse();
          record("native-egress-ack", { projectId: ack.projectId, containerId: ack.containerId });
        }
        callback(null, stdout, stderr);
      })().catch((failure) => callback(failure, stdout, stderr));
    });
    record("docker-child", { childPid: child.pid });
    return child;
  };
}
