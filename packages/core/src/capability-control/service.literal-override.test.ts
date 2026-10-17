import { afterAll, afterEach, expect, test } from "bun:test";
import children from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// All guards precede the actual SettingsManager/CapabilityService imports.
const attempts: string[] = [],
  probes: Array<{ kind: string; blocked: boolean }> = [];
const restores: Array<() => void> = [];
let probing = true;
const deny = (kind: string): never => {
  if (!probing) attempts.push(kind);
  throw Error("Owned literal-override fixture denies " + kind);
};
function forbid(target: Record<string, unknown>, name: string, kind: string) {
  const original = target[name];
  const blocked = () => deny(kind);
  target[name] = blocked;
  restores.push(() => {
    target[name] = original;
  });
  // No probe can fall through to an OS transport if installation failed.
  if (target[name] !== blocked) throw Error("Deny guard installation failed");
  try {
    (target[name] as () => never)();
  } catch (error) {
    probes.push({
      kind,
      blocked: (error as Error).message === "Owned literal-override fixture denies " + kind,
    });
  }
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  forbid(children as unknown as Record<string, unknown>, name, "child_process." + name);
forbid(process as unknown as Record<string, unknown>, "kill", "process.kill");
syncBuiltinESMExports();
const { installLocalNetworkGuard } =
  await import("../../../../scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");
forbid(globalThis as unknown as Record<string, unknown>, "fetch", "fetch");
for (const [transport, names, label] of [
  [http, ["request", "get"], "http"],
  [https, ["request", "get"], "https"],
  [net, ["connect", "createConnection"], "net"],
  [tls, ["connect"], "tls"],
] as const)
  for (const name of names)
    forbid(transport as unknown as Record<string, unknown>, name, label + "." + name);
forbid(net.Socket.prototype as unknown as Record<string, unknown>, "connect", "Socket.connect");
forbid(net.Server.prototype as unknown as Record<string, unknown>, "listen", "Server.listen");
syncBuiltinESMExports();
if (probes.length !== 18 || probes.some((probe) => !probe.blocked))
  throw Error("A finite transport guard probe failed");
probing = false;
const { SettingsManager } = await import("../settings/manager.js");
const { CapabilityService } = await import("./service.js");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(attempts).toEqual([]);
});
afterAll(() => {
  for (const restore of restores.reverse()) restore();
  syncBuiltinESMExports();
});
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const write = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
function fixture(project: Record<string, unknown> = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "codeshell-literal-overrides-")));
  roots.push(root);
  const cwd = join(root, "workspace"),
    user = join(root, "user-config"),
    config = join(cwd, ".code-shell");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  mkdirSync(user, { mode: 0o700 });
  const userFile = join(user, "settings.json"),
    projectFile = join(config, "settings.json"),
    localFile = join(config, "settings.local.json");
  write(userFile, {
    configVersion: 2,
    theme: "dark",
    mcpServers: {
      "team.docs": { command: "owned-never-launched", args: [] },
      team: { command: "owned-never-launched", args: [] },
      plain: { command: "owned-never-launched", args: [] },
    },
  });
  write(projectFile, { configVersion: 2, ...project });
  const manager = () => new SettingsManager(cwd, "full", true, user);
  const service = (settings = manager()) =>
    new CapabilityService({
      settings,
      cwd,
      registry: { listToolsDetailed: () => [] },
      scanSkills: () => [],
      scanAgents: () => [],
      readInstalledPlugins: () => ({ version: 2, plugins: {} }),
      resolveBuiltinToolNames: () => [],
    });
  return { root, cwd, user, userFile, projectFile, localFile, manager, service };
}

test("literal dotted MCP off writes schema-valid own key and preserves its ordinary sibling", () => {
  const f = fixture({
    theme: "light",
    capabilityOverrides: { mcp: { team: "on", sibling: "off" }, skills: { kept: "off" } },
  });
  const userBefore = readFileSync(f.userFile, "utf8");
  f.service().setOverride("mcp:team.docs", "off", { scope: "project", cwd: f.cwd });
  const saved = read(f.projectFile);
  let readbackError: string | null = null;
  try {
    f.manager().getForScope("project", f.cwd);
  } catch (error) {
    readbackError = (error as Error).message;
  }
  expect({ bucket: saved.capabilityOverrides.mcp, readbackError }).toEqual({
    bucket: { team: "on", sibling: "off", "team.docs": "off" },
    readbackError: null,
  });
  expect(saved.capabilityOverrides.skills).toEqual({ kept: "off" });
  expect(saved.theme).toBe("light");
  expect(
    f
      .service()
      .list(f.cwd)
      .find((row) => row.id === "mcp:team.docs"),
  ).toMatchObject({ enabled: false, projectOverride: "off" });
  expect(readFileSync(f.userFile, "utf8")).toBe(userBefore);
});

test("inherit removes an existing literal dotted entry, including a null tombstone", () => {
  for (const value of ["off", null]) {
    const f = fixture({
      capabilityOverrides: { mcp: { "team.docs": value, team: "off" }, skills: { kept: "on" } },
    });
    f.service().setOverride("mcp:team.docs", "inherit", { scope: "project", cwd: f.cwd });
    expect(read(f.projectFile).capabilityOverrides).toEqual({
      mcp: { team: "off" },
      skills: { kept: "on" },
    });
    expect(f.manager().getForScope("project", f.cwd).capabilityOverrides?.mcp).toEqual({
      team: "off",
    });
    expect(
      f
        .service()
        .list(f.cwd)
        .find((row) => row.id === "mcp:team.docs"),
    ).toMatchObject({ enabled: true, projectOverride: undefined });
  }
});

test("ordinary project on/off/inherit stays readable and the global file is unchanged", () => {
  const f = fixture(),
    original = readFileSync(f.userFile, "utf8");
  for (const state of ["off", "on"] as const) {
    f.service().setOverride("mcp:plain", state, { scope: "project", cwd: f.cwd });
    expect(f.manager().getForScope("project", f.cwd).capabilityOverrides?.mcp?.plain).toBe(state);
    expect(
      f
        .service()
        .list(f.cwd)
        .find((row) => row.id === "mcp:plain")?.enabled,
    ).toBe(state === "on");
  }
  f.service().setOverride("mcp:plain", "inherit", { scope: "project", cwd: f.cwd });
  expect(f.manager().getForScope("project", f.cwd).capabilityOverrides?.mcp).toEqual({});
  expect(readFileSync(f.userFile, "utf8")).toBe(original);
});

test("global dotted-name toggles retain the existing whole-server-record behavior", () => {
  const f = fixture(),
    projectBefore = readFileSync(f.projectFile, "utf8");
  f.service().setEnabled("mcp:team.docs", false);
  expect(f.manager().getForScope("user").mcpServers?.["team.docs"]?.enabled).toBe(false);
  f.service().setEnabled("mcp:team.docs", true);
  expect(f.manager().getForScope("user").mcpServers?.["team.docs"]?.enabled).toBe(true);
  expect(readFileSync(f.projectFile, "utf8")).toBe(projectBefore);
});

test("project writes preserve local/profile precedence and unrelated raw fields", () => {
  const f = fixture({
    profile: { active: "owned", overrides: { mcp: { plain: "off", "team.docs": "off" } } },
    capabilityOverrides: { agents: { kept: "off" } },
    ownedUnknown: { keep: "raw" },
  });
  write(f.localFile, { capabilityOverrides: { mcp: { plain: "off", "team.docs": "on" } } });
  const localBefore = readFileSync(f.localFile, "utf8"),
    userBefore = readFileSync(f.userFile, "utf8");
  f.service().setOverride("mcp:plain", "on", { scope: "project", cwd: f.cwd });
  expect(
    f
      .service()
      .list(f.cwd)
      .find((row) => row.id === "mcp:plain")?.enabled,
  ).toBe(false);
  expect(
    f
      .service()
      .list(f.cwd)
      .find((row) => row.id === "mcp:team.docs")?.enabled,
  ).toBe(true);
  expect(read(f.projectFile).capabilityOverrides.agents).toEqual({ kept: "off" });
  expect(read(f.projectFile).ownedUnknown).toEqual({ keep: "raw" });
  f.service().setOverride("mcp:plain", "inherit", { scope: "project", cwd: f.cwd });
  expect(readFileSync(f.localFile, "utf8")).toBe(localBefore);
  expect(readFileSync(f.userFile, "utf8")).toBe(userBefore);
});

test("inherit with absent key/root/bucket does not create or rewrite JSON", () => {
  const absent = fixture();
  unlinkSync(absent.projectFile);
  absent.service().setOverride("mcp:team.docs", "inherit", { scope: "project", cwd: absent.cwd });
  expect(existsSync(absent.projectFile)).toBe(false);
  for (const current of [
    {},
    { capabilityOverrides: null },
    { capabilityOverrides: { mcp: null } },
  ]) {
    const f = fixture(current),
      original = readFileSync(f.projectFile, "utf8");
    f.service().setOverride("mcp:team.docs", "inherit", { scope: "project", cwd: f.cwd });
    expect(readFileSync(f.projectFile, "utf8")).toBe(original);
  }
  // No claim of zero directory/lock IO: the mutation lock can create .code-shell.
});

test("malformed and already-invalid nested layers are refused without repairing their bytes", () => {
  for (const original of [
    '{"broken":',
    JSON.stringify({ configVersion: 2, capabilityOverrides: { mcp: { team: { docs: "off" } } } }),
  ]) {
    const f = fixture();
    writeFileSync(f.projectFile, original);
    expect(() =>
      f.service().setOverride("mcp:team.docs", "off", { scope: "project", cwd: f.cwd }),
    ).toThrow();
    expect(readFileSync(f.projectFile, "utf8")).toBe(original);
  }
});

test("unknown capability rejects without changing a layer", () => {
  const f = fixture(),
    original = readFileSync(f.projectFile, "utf8");
  expect(() =>
    f.service().setOverride("mcp:unknown", "off", { scope: "project", cwd: f.cwd }),
  ).toThrow();
  expect(readFileSync(f.projectFile, "utf8")).toBe(original);
});

test("the approved strict mutation contract rejects deleted cwd without rebuilding its root", () => {
  const f = fixture(),
    manager = f.manager(),
    service = f.service(manager);
  manager.get(); // Resolve the inert descriptor before the owned project is deleted.
  rmSync(f.cwd, { recursive: true });
  // Baseline saveProjectSetting silently no-ops here; the reviewed atomic API throws.
  expect(() => service.setOverride("mcp:plain", "off", { scope: "project", cwd: f.cwd })).toThrow(
    /project directory does not exist/,
  );
  expect(existsSync(f.cwd)).toBe(false);
});

test("a sibling committed by another manager before the actual lock is retained", () => {
  const f = fixture(),
    manager = f.manager();
  const save = manager.saveProjectSetting.bind(manager),
    mutate = manager.mutateSettingsForScope.bind(manager);
  const peerWrite = () =>
    f.manager().saveProjectSetting("capabilityOverrides.mcp.concurrent", "on", f.cwd);
  manager.saveProjectSetting = (...args) => {
    peerWrite();
    return save(...args);
  };
  manager.mutateSettingsForScope = (...args) => {
    peerWrite();
    return mutate(...args);
  };
  f.service(manager).setOverride("mcp:plain", "off", { scope: "project", cwd: f.cwd });
  expect(f.manager().getForScope("project", f.cwd).capabilityOverrides?.mcp).toEqual({
    concurrent: "on",
    plain: "off",
  });
  // Deterministic owned-FS interleaving, not an assertion of parallel OS execution.
});
