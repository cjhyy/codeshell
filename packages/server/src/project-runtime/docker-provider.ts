import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ManagedProjectSecret,
  ProjectRuntimeConnection,
  ProjectRuntimeProvider,
  ProjectRuntimeRecord,
  ProjectRuntimeStatus,
} from "./types.js";

export const DEFAULT_PROJECT_RUNTIME_IMAGE = "codeshell-project-runtime:local";
export const PROJECT_RUNTIME_SECRET_PATH = "/run/codeshell-project.json";
export const PROJECT_RUNTIME_LABEL = "io.codeshell.project-runtime";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DockerProjectProviderOptions {
  installationId: string;
  dataDir: string;
  image?: string;
  limits?: { memoryMb?: number; cpus?: number; pids?: number };
  commandTimeoutMs?: number;
  startupTimeoutMs?: number;
  /** Test seam; production always invokes Docker directly, without a shell. */
  command?: (args: string[], options: { signal: AbortSignal }) => Promise<DockerCommandResult>;
  healthCheck?: (url: string, signal: AbortSignal) => Promise<boolean>;
}

export class ProjectRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRuntimeError";
  }
}

function dockerCommand(args: string[], { signal }: { signal: AbortSignal }) {
  return new Promise<DockerCommandResult>((resolve, reject) => {
    execFile(
      "docker",
      args,
      { signal, encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(new ProjectRuntimeError("Docker command is unavailable or was interrupted."));
          return;
        }
        resolve({
          stdout,
          stderr,
          exitCode: error && typeof error.code === "number" ? error.code : 0,
        });
      },
    );
  });
}

function bounded(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new ProjectRuntimeError(`Invalid project ${label} limit.`);
  return value;
}

export function validateProjectRuntimeRecord(project: ProjectRuntimeRecord): void {
  if (
    !UUID.test(project.id) ||
    typeof project.ownerId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(project.ownerId) ||
    !Number.isSafeInteger(project.generation) ||
    project.generation < 0 ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(project.runtimeUsername) ||
    typeof project.runtimePassword !== "string" ||
    project.runtimePassword.length < 32 ||
    project.runtimePassword.length > 256 ||
    /[\0\r\n]/.test(project.runtimePassword)
  )
    throw new ProjectRuntimeError("Invalid managed project identity or credentials.");
}

export function validateProjectPublicOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value !== url.origin
  )
    throw new ProjectRuntimeError("Project publicOrigin must be an exact HTTP(S) origin.");
  return url.origin;
}

function labels(project: ProjectRuntimeRecord, installation: string) {
  return {
    [`${PROJECT_RUNTIME_LABEL}.installation`]: installation,
    [`${PROJECT_RUNTIME_LABEL}.project`]: project.id,
    [`${PROJECT_RUNTIME_LABEL}.owner`]: project.ownerId,
  };
}

function mustOwn(resource: any, expected: Record<string, string>): void {
  const actual = resource?.Config?.Labels ?? resource?.Labels;
  if (!actual || Object.entries(expected).some(([key, value]) => actual[key] !== value))
    throw new ProjectRuntimeError("Docker resource identity does not match this project.");
}

function connectionUrl(resource: any): string {
  const bindings = resource?.NetworkSettings?.Ports?.["8790/tcp"];
  if (
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    bindings[0]?.HostIp !== "127.0.0.1" ||
    !/^\d{1,5}$/.test(bindings[0]?.HostPort ?? "") ||
    Number(bindings[0].HostPort) < 1 ||
    Number(bindings[0].HostPort) > 65535
  )
    throw new ProjectRuntimeError("Project container must publish only a loopback runtime port.");
  return `http://127.0.0.1:${Number(bindings[0].HostPort)}`;
}

function interrupted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new ProjectRuntimeError("Project operation was cancelled or timed out.");
}

async function within<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  interrupted(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(new ProjectRuntimeError("Project operation was cancelled or timed out."));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** An administrator-owned Docker control client. Project tasks never receive this client. */
export function createDockerProjectProvider(
  options: DockerProjectProviderOptions,
): ProjectRuntimeProvider {
  if (!UUID.test(options.installationId)) throw new ProjectRuntimeError("Invalid installation id.");
  const image = options.image ?? DEFAULT_PROJECT_RUNTIME_IMAGE;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image))
    throw new ProjectRuntimeError("Invalid project runtime image.");
  const dataDir = resolve(options.dataDir);
  if (/[\0,\r\n]/.test(dataDir))
    throw new ProjectRuntimeError("Unsupported project metadata path.");
  const memory = bounded(options.limits?.memoryMb ?? 2048, 128, 262144, "memory");
  const cpus = bounded(options.limits?.cpus ?? 2, 0.1, 128, "CPU");
  const pids = bounded(options.limits?.pids ?? 256, 16, 65536, "process");
  if (!Number.isInteger(memory) || !Number.isInteger(pids))
    throw new ProjectRuntimeError("Invalid resource limits.");
  const commandTimeout = bounded(options.commandTimeoutMs ?? 15000, 10, 120000, "command timeout");
  const startupTimeout = bounded(options.startupTimeoutMs ?? 90000, 10, 300000, "startup timeout");
  const command = options.command ?? dockerCommand;
  const healthCheck =
    options.healthCheck ??
    (async (url, signal) => {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
        redirect: "error",
      });
      await response.body?.cancel();
      return response.ok;
    });
  const lifetime = new AbortController();
  const pending = new Map<
    string,
    { key: string; controller: AbortController; promise: Promise<ProjectRuntimeConnection> }
  >();
  const stops = new Map<string, Promise<void>>();
  const operations = new Set<Promise<unknown>>();

  function names(project: ProjectRuntimeRecord) {
    const base = `codeshell-${options.installationId}-${project.id}`;
    return {
      container: base,
      data: `${base}-data`,
      workspace: `${base}-workspace`,
      network: `${base}-network`,
    };
  }

  async function invoke(args: string[], signal = lifetime.signal): Promise<DockerCommandResult> {
    const boundedSignal = AbortSignal.any([
      signal,
      lifetime.signal,
      AbortSignal.timeout(commandTimeout),
    ]);
    interrupted(boundedSignal);
    return within(command(args, { signal: boundedSignal }), boundedSignal);
  }

  async function successful(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await invoke(args, signal);
    if (result.exitCode !== 0) throw new ProjectRuntimeError(`Docker ${args[0]} operation failed.`);
    return result.stdout;
  }

  async function inspect(
    kind: "container" | "network" | "volume",
    name: string,
    signal?: AbortSignal,
  ): Promise<any | null> {
    const result = await invoke([kind, "inspect", name], signal);
    if (result.exitCode !== 0) {
      if (/no such (?:container|network|volume|object)|not found/i.test(result.stderr)) return null;
      throw new ProjectRuntimeError(`Cannot inspect project Docker ${kind}.`);
    }
    try {
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]) throw new Error();
      return parsed[0];
    } catch {
      throw new ProjectRuntimeError(`Invalid Docker ${kind} inspection response.`);
    }
  }

  async function resource(
    kind: "volume" | "network",
    name: string,
    expected: Record<string, string>,
    signal: AbortSignal,
  ) {
    const existing = await inspect(kind, name, signal);
    if (existing) {
      mustOwn(existing, expected);
      return;
    }
    const args = [kind, "create"];
    for (const [key, value] of Object.entries(expected)) args.push("--label", `${key}=${value}`);
    if (kind === "network")
      args.push("--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false");
    args.push(name);
    await successful(args, signal);
    interrupted(signal);
    mustOwn(await inspect(kind, name, signal), expected);
  }

  async function secretFile(
    project: ProjectRuntimeRecord,
    secret: ManagedProjectSecret,
    signal: AbortSignal,
  ) {
    const directory = join(dataDir, "project-runtime-secrets", project.id);
    for (const dir of [join(dataDir, "project-runtime-secrets"), directory]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      interrupted(signal);
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ProjectRuntimeError("Unsafe project secret directory.");
      await chmod(dir, 0o700);
      interrupted(signal);
    }
    const destination = join(directory, "runtime.json");
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        interrupted(signal);
        await handle.writeFile(`${JSON.stringify(secret)}\n`, "utf8");
        // The parent is private (0700); only this file is mounted, read-only, into
        // the container. World-readable file mode supports its non-root UID.
        await handle.chmod(0o444);
      } finally {
        await handle.close();
      }
      interrupted(signal);
      await rename(temporary, destination);
      interrupted(signal);
      return destination;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    operations.add(promise);
    void promise.finally(() => operations.delete(promise)).catch(() => {});
    return promise;
  }

  async function stopOwned(project: ProjectRuntimeRecord): Promise<void> {
    const name = names(project).container;
    const existing = await inspect("container", name);
    if (!existing) return;
    mustOwn(existing, labels(project, options.installationId));
    if (existing.State?.Running) await successful(["container", "stop", "--time", "5", name]);
  }

  async function start(
    project: ProjectRuntimeRecord,
    publicOrigin: string,
    signal: AbortSignal,
  ): Promise<ProjectRuntimeConnection> {
    const expected = labels(project, options.installationId);
    const named = names(project);
    const secret: ManagedProjectSecret = {
      version: 1,
      projectId: project.id,
      ownerId: project.ownerId,
      generation: project.generation,
      username: project.runtimeUsername,
      password: project.runtimePassword,
      publicOrigin,
      publicPathPrefix: `/p/${project.id}`,
    };
    const configuration = createHash("sha256").update(JSON.stringify(secret)).digest("hex");
    const configLabel = `${PROJECT_RUNTIME_LABEL}.configuration`;
    const generationLabel = `${PROJECT_RUNTIME_LABEL}.generation`;
    const imageResult = await invoke(["image", "inspect", image], signal);
    if (imageResult.exitCode !== 0)
      throw new ProjectRuntimeError(
        `Project runtime image ${image} is unavailable; build it before starting projects.`,
      );
    let existing = await inspect("container", named.container, signal);
    if (existing) {
      mustOwn(existing, expected);
      const same =
        existing.Config?.Labels?.[generationLabel] === String(project.generation) &&
        existing.Config?.Labels?.[configLabel] === configuration;
      if (!same) {
        if (existing.State?.Running)
          throw new ProjectRuntimeError(
            "A different project generation is still running; stop it before starting a new generation.",
          );
        await successful(["container", "rm", named.container], signal);
        existing = null;
      }
    }
    if (!existing) {
      await resource("network", named.network, expected, signal);
      await resource("volume", named.data, expected, signal);
      await resource("volume", named.workspace, expected, signal);
      const file = await secretFile(project, secret, signal);
      const args = [
        "container",
        "create",
        "--name",
        named.container,
        "--init",
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--memory",
        `${memory}m`,
        "--memory-swap",
        `${memory}m`,
        "--cpus",
        String(cpus),
        "--pids-limit",
        String(pids),
        "--ulimit",
        "nofile=4096:4096",
        "--shm-size",
        "128m",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=268435456,mode=1777",
        "--network",
        named.network,
        "--publish",
        "127.0.0.1::8790",
        "--workdir",
        "/workspace",
        "--mount",
        `type=volume,source=${named.data},target=/data`,
        "--mount",
        `type=volume,source=${named.workspace},target=/workspace`,
        "--mount",
        `type=bind,source=${file},target=${PROJECT_RUNTIME_SECRET_PATH},readonly`,
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
      for (const [key, value] of Object.entries({
        ...expected,
        [generationLabel]: String(project.generation),
        [configLabel]: configuration,
      }))
        args.push("--label", `${key}=${value}`);
      args.push(
        image,
        "/opt/codeshell/packages/server/dist/bin/code-shell-project-runtime.js",
        "--secret",
        PROJECT_RUNTIME_SECRET_PATH,
      );
      await successful(args, signal);
      interrupted(signal);
      existing = await inspect("container", named.container, signal);
      mustOwn(existing, expected);
    }
    const startedHere = !existing.State?.Running;
    try {
      if (startedHere) await successful(["container", "start", named.container], signal);
      interrupted(signal);
      existing = await inspect("container", named.container, signal);
      mustOwn(existing, {
        ...expected,
        [generationLabel]: String(project.generation),
        [configLabel]: configuration,
      });
      const url = connectionUrl(existing);
      while (true) {
        interrupted(signal);
        try {
          if (await within(healthCheck(url, signal), signal)) break;
        } catch {
          interrupted(signal);
        }
        const state = await inspect("container", named.container, signal);
        mustOwn(state, expected);
        if (!state.State?.Running)
          throw new ProjectRuntimeError("Project runtime exited before becoming ready.");
        await within(new Promise<void>((resolve) => setTimeout(resolve, 200)), signal);
      }
      interrupted(signal);
      return {
        url,
        username: project.runtimeUsername,
        password: project.runtimePassword,
        generation: project.generation,
      };
    } catch (error) {
      // Readiness failures must not leave a task process running behind a failed
      // project state. Only stop this exact generation, never delete its volumes.
      if (startedHere && !lifetime.signal.aborted) {
        try {
          const current = await inspect("container", named.container);
          mustOwn(current, {
            ...expected,
            [generationLabel]: String(project.generation),
            [configLabel]: configuration,
          });
          if (current.State?.Running)
            await successful(["container", "stop", "--time", "5", named.container]);
        } catch {
          // Preserve the original startup error; explicit stop can retry cleanup.
        }
      }
      throw error;
    }
  }

  return {
    availability() {
      return track(
        (async () => {
          try {
            if ((await invoke(["info", "--format", "{{json .ServerVersion}}"])).exitCode !== 0)
              return { available: false, error: "Docker is not running or cannot be reached." };
            if ((await invoke(["image", "inspect", image])).exitCode !== 0)
              return {
                available: false,
                error: `Build the project runtime image ${image} before starting projects.`,
              };
            return { available: true };
          } catch {
            return {
              available: false,
              error: "Docker is not installed, is stopped, or did not respond in time.",
            };
          }
        })(),
      );
    },
    ensure(project, { publicOrigin }) {
      validateProjectRuntimeRecord(project);
      if (project.generation < 1)
        throw new ProjectRuntimeError("A project generation must be allocated before starting.");
      validateProjectPublicOrigin(publicOrigin);
      interrupted(lifetime.signal);
      if (stops.has(project.id))
        return Promise.reject(new ProjectRuntimeError("Project is stopping."));
      const snapshot = { ...project };
      const key = JSON.stringify({ ...snapshot, publicOrigin });
      const current = pending.get(project.id);
      if (current) {
        if (current.key !== key)
          return Promise.reject(new ProjectRuntimeError("Another project generation is starting."));
        return current.promise;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        lifetime.signal,
        AbortSignal.timeout(startupTimeout),
      ]);
      const promise = start(snapshot, publicOrigin, signal).finally(() => {
        if (pending.get(project.id)?.controller === controller) pending.delete(project.id);
      });
      pending.set(project.id, { key, controller, promise });
      return track(promise);
    },
    stop(project) {
      validateProjectRuntimeRecord(project);
      if (project.generation === 0) return Promise.resolve();
      interrupted(lifetime.signal);
      const current = stops.get(project.id);
      if (current) return current;
      const snapshot = { ...project };
      const starting = pending.get(project.id);
      starting?.controller.abort();
      const operation = (async () => {
        await starting?.promise.catch(() => {});
        await stopOwned(snapshot);
      })().finally(() => stops.delete(project.id));
      stops.set(project.id, operation);
      return track(operation);
    },
    status(project): Promise<ProjectRuntimeStatus> {
      validateProjectRuntimeRecord(project);
      if (project.generation === 0) return Promise.resolve({ state: "missing" });
      return track(
        (async () => {
          const current = await inspect("container", names(project).container);
          if (!current) return { state: "missing" as const };
          mustOwn(current, labels(project, options.installationId));
          return current.State?.Running
            ? { state: "running" as const, url: connectionUrl(current) }
            : { state: "stopped" as const };
        })(),
      );
    },
    async close() {
      lifetime.abort();
      await Promise.allSettled([...operations]);
    },
  };
}
