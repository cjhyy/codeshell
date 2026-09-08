import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDockerProjectProvider,
  DEFAULT_PROJECT_RUNTIME_IMAGE,
  PROJECT_RUNTIME_LABEL,
  type DockerCommandResult,
} from "./docker-provider.js";
import type { ProjectRuntimeRecord } from "./types.js";

const installationId = "11111111-1111-4111-8111-111111111111";
const project: ProjectRuntimeRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  ownerId: "owner-one",
  generation: 1,
  runtimeUsername: "project-admin",
  runtimePassword: "only-this-project-" + "x".repeat(32),
};
const origin = { publicOrigin: "https://codeshell.example" };
const temporary: string[] = [];
const providers: ReturnType<typeof createDockerProjectProvider>[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fakeDocker() {
  const commands: string[][] = [];
  const containers = new Map<string, any>();
  const networks = new Map<string, any>();
  const volumes = new Map<string, any>();
  let imageExists = true;
  let daemonAvailable = true;
  const ok = (stdout = ""): DockerCommandResult => ({ stdout, stderr: "", exitCode: 0 });
  const values = (args: string[], flag: string) =>
    args.flatMap((value, index) => (value === flag ? [args[index + 1]!] : []));
  const command = async (args: string[]): Promise<DockerCommandResult> => {
    commands.push([...args]);
    if (args[0] === "info")
      return daemonAvailable ? ok('"27"') : { stdout: "", stderr: "unavailable", exitCode: 1 };
    if (args[0] === "image")
      return imageExists ? ok("[]") : { stdout: "", stderr: "No such image", exitCode: 1 };
    const map = args[0] === "container" ? containers : args[0] === "network" ? networks : volumes;
    if (args[1] === "inspect") {
      const entry = map.get(args[2]!);
      return entry
        ? ok(JSON.stringify([entry]))
        : { stdout: "", stderr: `No such ${args[0]}`, exitCode: 1 };
    }
    if (args[1] === "create") {
      const name = args[0] === "container" ? values(args, "--name")[0]! : args.at(-1)!;
      const labels = Object.fromEntries(
        values(args, "--label").map((value) => {
          const equal = value.indexOf("=");
          return [value.slice(0, equal), value.slice(equal + 1)];
        }),
      );
      map.set(
        name,
        args[0] === "container"
          ? {
              Id: name,
              Config: { Labels: labels },
              State: { Running: false },
              NetworkSettings: {
                Ports: { "8790/tcp": [{ HostIp: "127.0.0.1", HostPort: "49155" }] },
              },
            }
          : { Name: name, Labels: labels },
      );
      return ok(name);
    }
    const name = args.at(-1)!;
    if (args[1] === "start") {
      map.get(name).State.Running = true;
      return ok(name);
    }
    if (args[1] === "stop") {
      map.get(name).State.Running = false;
      return ok(name);
    }
    if (args[1] === "rm") {
      map.delete(name);
      return ok(name);
    }
    throw new Error(`Unexpected fake Docker command: ${args.join(" ")}`);
  };
  return {
    commands,
    containers,
    networks,
    volumes,
    command,
    values,
    setImage: (value: boolean) => {
      imageExists = value;
    },
    setDaemon: (value: boolean) => {
      daemonAvailable = value;
    },
  };
}

async function fixture(extra: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "codeshell-project-provider-"));
  temporary.push(dataDir);
  const docker = fakeDocker();
  const provider = createDockerProjectProvider({
    installationId,
    dataDir,
    command: docker.command,
    healthCheck: async () => true,
    ...extra,
  });
  providers.push(provider);
  return { dataDir, docker, provider };
}

test("project start creates separate labelled volumes/network, bounded non-root container and one read-only secret mount", async () => {
  const { provider, docker, dataDir } = await fixture();
  const result = await provider.ensure(project, origin);
  expect(result).toEqual({
    url: "http://127.0.0.1:49155",
    username: project.runtimeUsername,
    password: project.runtimePassword,
    generation: 1,
  });
  const args = docker.commands.find((entry) => entry[0] === "container" && entry[1] === "create")!;
  for (const value of [
    "--read-only",
    "--init",
    "ALL",
    "no-new-privileges:true",
    "1000:1000",
    "127.0.0.1::8790",
    "2048m",
    "256",
    "2",
    DEFAULT_PROJECT_RUNTIME_IMAGE,
  ])
    expect(args).toContain(value);
  expect(docker.values(args, "--env")).toEqual([
    "HOME=/data/home",
    "CODE_SHELL_HOME=/data/home/.code-shell",
    "NPM_CONFIG_CACHE=/data/home/.npm",
    "NPM_CONFIG_PREFIX=/data/home/.local",
    "PATH=/data/panel-bin:/data/home/.local/bin:/data/home/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "PYTHONUSERBASE=/data/home/.local",
    "PIP_CACHE_DIR=/data/home/.cache/pip",
  ]);
  const mounts = docker.values(args, "--mount");
  expect(mounts).toHaveLength(3);
  expect(mounts.filter((value) => value.startsWith("type=volume,"))).toHaveLength(2);
  expect(mounts.find((value) => value.startsWith("type=bind,"))).toBe(
    `type=bind,source=${dataDir}/project-runtime-secrets/${project.id}/runtime.json,target=/run/codeshell-project.json,readonly`,
  );
  expect(args.join(" ")).not.toContain(project.runtimePassword);
  expect(args.join(" ")).not.toContain("docker.sock");
  expect(docker.networks.size).toBe(1);
  expect(docker.volumes.size).toBe(2);
  const directory = join(dataDir, "project-runtime-secrets", project.id);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, "runtime.json"))).mode & 0o777).toBe(0o444);
  expect(JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"))).toMatchObject({
    projectId: project.id,
    password: project.runtimePassword,
    publicOrigin: origin.publicOrigin,
    publicPathPrefix: `/p/${project.id}`,
  });
});

test("parallel starts share one pending creation and different generation requests cannot join it", async () => {
  let ready = (): void => {};
  const health = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const { provider, docker } = await fixture({
    healthCheck: async () => {
      await health;
      return true;
    },
  });
  const first = provider.ensure(project, origin);
  const second = provider.ensure({ ...project }, origin);
  expect(first).toBe(second);
  await expect(provider.ensure({ ...project, generation: 2 }, origin)).rejects.toThrow(
    "Another project generation",
  );
  ready();
  await Promise.all([first, second]);
  expect(
    docker.commands.filter((args) => args[0] === "container" && args[1] === "create"),
  ).toHaveLength(1);
});

test("stop preserves volumes; next generation reuses them and replaces only the stopped container", async () => {
  const { provider, docker } = await fixture();
  expect(await provider.status(project)).toEqual({ state: "missing" });
  await provider.ensure(project, origin);
  await expect(provider.ensure({ ...project, generation: 2 }, origin)).rejects.toThrow(
    "different project generation is still running",
  );
  expect((await provider.status(project)).state).toBe("running");
  await provider.stop(project);
  expect(await provider.status(project)).toEqual({ state: "stopped" });
  const names = [...docker.volumes.keys()];
  const result = await provider.ensure({ ...project, generation: 2 }, origin);
  expect(result.generation).toBe(2);
  expect([...docker.volumes.keys()]).toEqual(names);
  expect(
    docker.commands.filter((args) => args[0] === "volume" && args[1] === "create"),
  ).toHaveLength(2);
  expect(docker.commands.filter((args) => args[1] === "rm")).toHaveLength(1);
  expect(docker.commands.find((args) => args[1] === "rm")![0]).toBe("container");
});

test("labels guard every existing container, volume and network before mutations", async () => {
  for (const kind of ["container", "network", "volume"] as const) {
    const { provider, docker } = await fixture();
    await provider.ensure(project, origin);
    await provider.stop(project);
    if (kind !== "container") docker.containers.clear();
    const map =
      kind === "container"
        ? docker.containers
        : kind === "network"
          ? docker.networks
          : docker.volumes;
    const entry = [...map.values()][0];
    const labels = entry.Config?.Labels ?? entry.Labels;
    labels[`${PROJECT_RUNTIME_LABEL}.installation`] = "another-installation";
    docker.commands.length = 0;
    await expect(provider.ensure(project, origin)).rejects.toThrow("identity does not match");
    expect(docker.commands.some((args) => ["rm", "start", "stop"].includes(args[1]!))).toBe(false);
    if (kind === "container") {
      await expect(provider.stop(project)).rejects.toThrow("identity does not match");
      await expect(provider.status(project)).rejects.toThrow("identity does not match");
    }
  }
});

test("project owner mismatch cannot inspect or stop an existing runtime", async () => {
  const { provider, docker } = await fixture();
  await provider.ensure(project, origin);
  const foreign = { ...project, ownerId: "other-owner" };
  await expect(provider.stop(foreign)).rejects.toThrow("identity does not match");
  await expect(provider.status(foreign)).rejects.toThrow("identity does not match");
  expect([...docker.containers.values()][0].State.Running).toBe(true);
});

test("stop cancels an in-flight readiness check and cannot leave the runtime running", async () => {
  let entered = (): void => {};
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { provider, docker } = await fixture({
    healthCheck: () => {
      entered();
      return new Promise(() => {});
    },
  });
  const starting = provider.ensure(project, origin);
  const rejection = starting.catch((error) => error);
  await began;
  await provider.stop(project);
  expect((await rejection).message).toContain("cancelled or timed out");
  expect([...docker.containers.values()][0].State.Running).toBe(false);
  expect(await provider.status(project)).toEqual({ state: "stopped" });
});

test("availability reports stopped Docker and missing image without pulling or starting anything", async () => {
  const { provider, docker } = await fixture();
  docker.setDaemon(false);
  expect(await provider.availability()).toMatchObject({ available: false });
  docker.setDaemon(true);
  docker.setImage(false);
  expect(await provider.availability()).toMatchObject({
    available: false,
    error: expect.stringContaining(DEFAULT_PROJECT_RUNTIME_IMAGE),
  });
  await expect(provider.ensure(project, origin)).rejects.toThrow("build it before starting");
  expect(
    docker.commands.some((args) => ["pull", "run", "create", "start"].includes(args[1]!)),
  ).toBe(false);
  docker.setImage(true);
  expect(await provider.availability()).toEqual({ available: true });
});

test("commands have a deadline and provider close cancels pending commands without deleting volumes", async () => {
  const first = await fixture({ commandTimeoutMs: 20, command: () => new Promise(() => {}) });
  const before = Date.now();
  expect(await first.provider.availability()).toMatchObject({ available: false });
  expect(Date.now() - before).toBeLessThan(1000);
  const second = await fixture({ command: () => new Promise(() => {}) });
  const starting = second.provider.ensure(project, origin);
  const rejection = starting.catch((error) => error);
  await second.provider.close();
  expect((await rejection).message).toContain("cancelled or timed out");
  expect(second.docker.commands).toEqual([]);
});

test("a container published outside loopback is never returned as a project connection", async () => {
  const { provider, docker } = await fixture();
  await provider.ensure(project, origin);
  [...docker.containers.values()][0].NetworkSettings.Ports["8790/tcp"][0].HostIp = "0.0.0.0";
  await expect(provider.ensure(project, origin)).rejects.toThrow("loopback");
  await expect(provider.status(project)).rejects.toThrow("loopback");
});

test("startup timeout stops the failed generation without deleting any persistent resource", async () => {
  const { provider, docker } = await fixture({
    startupTimeoutMs: 50,
    healthCheck: () => new Promise(() => {}),
  });
  await expect(provider.ensure(project, origin)).rejects.toThrow("cancelled or timed out");
  expect([...docker.containers.values()][0].State.Running).toBe(false);
  expect(docker.volumes.size).toBe(2);
  expect(docker.commands.some((args) => args[1] === "rm")).toBe(false);
});

test("a never-started project can be inspected or stopped without invoking Docker", async () => {
  const { provider, docker } = await fixture();
  const fresh = { ...project, generation: 0 };
  expect(await provider.status(fresh)).toEqual({ state: "missing" });
  await provider.stop(fresh);
  expect(docker.commands).toEqual([]);
  expect(() => provider.ensure(fresh, origin)).toThrow("generation must be allocated");
});
