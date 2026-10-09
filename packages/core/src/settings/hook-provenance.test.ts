import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dgram from "node:dgram";
import type { SettingsHookOrigin } from "./hook-provenance.js";

// This source-only fixture authorizes no network origin. Install its guard
// before Core imports; the guarded runner separately supplies a private HOME.
const networkAttempt = () => {
  throw new Error("Settings provenance fixture has no authorized network origin");
};
const restoreNetwork: (() => void)[] = [];
for (const [target, key] of [
  [globalThis, "fetch"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
  [net.Socket.prototype, "connect"],
  [dgram.Socket.prototype, "send"],
] as const) {
  const object = target as unknown as Record<string, unknown>;
  const previous = object[key];
  object[key] = networkAttempt;
  restoreNetwork.push(() => {
    object[key] = previous;
  });
}
afterAll(() => {
  for (const restore of restoreNetwork) restore();
});

const { SettingsManager } = await import("./manager.js");
const { assertSettingsHookOriginCurrent, readSettingsHookSnapshot, settingsHookDefinitionSha256 } =
  await import("./hook-provenance.js");

const readonlyOrigins = { persistMigrations: false, hookOrigins: true } as const;
const hook = (command: string) => ({ event: "pre_tool_use", command });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("Settings executable Hook RAW provenance", () => {
  let directory: string;
  let home: string;
  let cwd: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-settings-origin-")));
    home = join(directory, "home");
    cwd = join(directory, "project");
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  });

  function seed(root: string, name: string, value: unknown): string {
    const path = join(root, ".code-shell", name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    return path;
  }

  function load(scope: "full" | "project" = "full", trusted = true) {
    const manager = new SettingsManager(cwd, scope, trusted);
    manager.load(undefined, readonlyOrigins);
    return manager;
  }

  function first(manager: InstanceType<typeof SettingsManager>): SettingsHookOrigin {
    const origin = manager.getHookOrigins()[0];
    expect(origin).toBeDefined();
    return origin!;
  }

  test("same raw bytes bind normalized Hook data and frozen metadata", () => {
    const raw = '{ "hooks": [{ "command":"node entry.mjs", "event":"pre_tool_use", "extra":42 }] }';
    const path = seed(home, "settings.json", raw);
    const manager = load();
    const origin = first(manager);
    expect(origin).toMatchObject({
      kind: "settings",
      layer: "user",
      path,
      rawSha256: sha(raw),
      sourceLayerIndex: 0,
      definitionSha256: settingsHookDefinitionSha256(manager.get().hooks![0]),
    });
    expect(manager.get().hooks![0]).toEqual(hook("node entry.mjs"));
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.custody.file)).toBe(true);
    expect(Object.isFrozen(origin.custody.parents)).toBe(true);
    expect(() => assertSettingsHookOriginCurrent(origin)).not.toThrow();
    expect(JSON.stringify(origin)).not.toContain("node entry.mjs");
    expect(JSON.stringify(origin)).not.toContain("extra");
  });

  test("BOM JSON stays skipped while ordinary UTF-8 and YAML selection stay identical", () => {
    const jsonPath = seed(
      cwd,
      "settings.json",
      `\uFEFF${JSON.stringify({ hooks: [hook("bom-json")] })}`,
    );
    const ordinary = new SettingsManager(cwd, "project", true);
    ordinary.load(undefined, { persistMigrations: false });
    const opted = load("project");
    expect(opted.get()).toEqual(ordinary.get());
    expect(opted.get().hooks).toBeUndefined();
    expect(opted.getHookOrigins()).toEqual([]);
    rmSync(jsonPath);
    seed(
      cwd,
      "settings.yaml",
      "\uFEFFhooks:\n  - event: pre_tool_use\n    command: yaml-command\n",
    );
    const yamlOrdinary = new SettingsManager(cwd, "project", true);
    yamlOrdinary.load(undefined, { persistMigrations: false });
    const yamlOpted = load("project");
    expect(yamlOpted.get()).toEqual(yamlOrdinary.get());
    expect(first(yamlOpted).rawSha256).toBe(
      sha(readFileSync(join(cwd, ".code-shell/settings.yaml"))),
    );
    rmSync(join(cwd, ".code-shell/settings.yaml"));
    seed(cwd, "settings.json", { hooks: [hook("valid-json")] });
    expect(first(load("project"))).toBeDefined();
  });

  test("managed/user/project/local concat and source indices follow the actual merge", () => {
    seed(home, "settings.managed.json", { hooks: [hook("managed")] });
    seed(home, "settings.json", { hooks: [hook("user-a"), hook("user-b")] });
    seed(cwd, "settings.json", { hooks: [hook("project")] });
    seed(cwd, "settings.local.json", { hooks: [hook("local-a"), hook("local-b")] });
    const manager = load();
    expect(
      manager.getHookOrigins().map((origin) => [origin?.layer, origin?.sourceLayerIndex]),
    ).toEqual([
      ["managed", 0],
      ["user", 0],
      ["user", 1],
      ["project", 0],
      ["local", 0],
      ["local", 1],
    ]);
    seed(cwd, "settings.json", { hooks: null });
    manager.load(undefined, readonlyOrigins);
    expect(manager.get().hooks?.map((entry) => entry.command)).toEqual(["local-a", "local-b"]);
    expect(
      manager.getHookOrigins().map((origin) => [origin?.layer, origin?.sourceLayerIndex]),
    ).toEqual([
      ["local", 0],
      ["local", 1],
    ]);
  });

  test("present unproven higher layers block lower resource origins without changing ordinary Hook selection", () => {
    seed(home, "settings.json", { hooks: [hook("user-hook")] });
    const projectPath = seed(cwd, "settings.json", "{invalid");
    const ordinary = new SettingsManager(cwd, "full", true);
    ordinary.load(undefined, { persistMigrations: false });
    let opted = load();
    expect(opted.get()).toEqual(ordinary.get());
    expect(opted.get().hooks?.map((entry) => entry.command)).toEqual(["user-hook"]);
    expect(opted.getHookOrigins()).toEqual([undefined]);
    writeFileSync(
      projectPath,
      Buffer.concat([Buffer.from('{"description":"'), Buffer.from([255]), Buffer.from('"}')]),
    );
    opted = load();
    expect(opted.get().hooks?.map((entry) => entry.command)).toEqual(["user-hook"]);
    expect(opted.getHookOrigins()).toEqual([undefined]);
    seed(cwd, "settings.local.json", { hooks: [hook("local-hook")] });
    opted = load();
    expect(opted.getHookOrigins()[0]).toBeUndefined();
    expect(opted.getHookOrigins()[1]).toMatchObject({ layer: "local", sourceLayerIndex: 0 });
    rmSync(projectPath);
    const target = join(directory, "linked-project.json");
    writeFileSync(target, "{}");
    symlinkSync(target, projectPath);
    opted = load();
    expect(opted.getHookOrigins()[0]).toBeUndefined();
    expect(opted.getHookOrigins()[1]).toMatchObject({ layer: "local", sourceLayerIndex: 0 });
    rmSync(projectPath);
    rmSync(join(cwd, ".code-shell/settings.local.json"));
    expect(first(load()).layer).toBe("user");
  });

  test("untrusted filtering and disabled entries retain their exact association", () => {
    seed(home, "settings.json", { hooks: [{ ...hook("user"), disabled: true }] });
    seed(cwd, "settings.json", { hooks: [hook("project")] });
    seed(cwd, "settings.local.json", { hooks: [hook("local")] });
    const manager = load("full", false);
    expect(manager.get().hooks).toEqual([{ ...hook("user"), disabled: true }]);
    expect(manager.getHookOrigins().map((origin) => origin?.layer)).toEqual(["user"]);
  });

  test("JSON wins over YAML and newly appearing higher-priority candidates revoke", () => {
    const yaml = seed(cwd, "settings.yaml", "hooks:\n  - event: pre_tool_use\n    command: yaml\n");
    const manager = load("project");
    const origin = first(manager);
    expect(origin.path).toBe(yaml);
    seed(cwd, "settings.json", { hooks: [hook("json")] });
    expect(() => assertSettingsHookOriginCurrent(origin)).toThrow();
    manager.load(undefined, readonlyOrigins);
    expect(manager.get().hooks?.[0]?.command).toBe("json");
    expect(first(manager).path).toBe(join(cwd, ".code-shell", "settings.json"));
  });

  test("an unsafe higher-priority JSON cannot activate lower YAML provenance", () => {
    seed(cwd, "settings.yaml", "hooks:\n  - event: pre_tool_use\n    command: lower\n");
    const target = join(directory, "other.json");
    writeFileSync(target, JSON.stringify({ hooks: [hook("other")] }));
    symlinkSync(target, join(cwd, ".code-shell", "settings.json"));
    const manager = load("project");
    expect(manager.get().hooks).toBeUndefined();
    expect(manager.getHookOrigins()).toEqual([]);
  });

  test("read-only version and legacy model migrations keep the original pair without writes", () => {
    const path = seed(home, "settings.json", {
      hooks: [hook("migrated")],
      imageGen: { providers: [{ id: "image", kind: "openai", baseUrl: "https://denied.invalid" }] },
      sandbox: { mode: "auto", network: "allow", writableRoots: [], deniedReads: [] },
      models: [{ key: "legacy", model: "synthetic", provider: "x" }],
    });
    const bytes = readFileSync(path);
    const manager = load();
    expect(manager.get().sandbox).toBeUndefined();
    expect(manager.get().models?.[0]?.providerKey).toBe("custom");
    expect(manager.get().imageGen?.providers[0]?.catalogId).toBe("openai-images");
    expect(first(manager).rawSha256).toBe(sha(bytes));
    expect(() => assertSettingsHookOriginCurrent(first(manager))).not.toThrow();
    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  test("persistent migration clears old provenance before its actual disk replacement", () => {
    const path = seed(home, "settings.json", {
      hooks: [hook("before")],
      sandbox: { mode: "auto", network: "allow", writableRoots: [], deniedReads: [] },
    });
    const manager = new SettingsManager(cwd, "full");
    // This controls sequencing only; both source parses use actual filesystem
    // reads. No mocked descriptor is used as evidence of snapshot stability.
    const internal = manager as unknown as {
      applyConfigMigration: (path: string, name: string, persist?: boolean) => void;
    };
    const migrate = internal.applyConfigMigration.bind(manager);
    internal.applyConfigMigration = (candidate, name, persist) => {
      if (name === "user")
        seed(home, "settings.json", {
          hooks: [hook("second-read")],
          sandbox: { mode: "auto", network: "allow", writableRoots: [], deniedReads: [] },
        });
      migrate(candidate, name, persist);
    };
    manager.load(undefined, { hookOrigins: true });
    expect(manager.get().hooks?.[0]?.command).toBe("second-read");
    expect(manager.getHookOrigins()).toEqual([undefined]);
    expect(existsSync(`${path}.bak`)).toBe(true);
  });

  test("save, delete, mutate, failed write and invalidate remove usable origins", () => {
    const path = seed(home, "settings.json", { hooks: [hook("user")], theme: "dark" });
    const manager = load();
    manager.saveUserSetting("theme", "light");
    expect(manager.getHookOrigins()).toEqual([]);
    manager.load(undefined, readonlyOrigins);
    first(manager);
    manager.deleteUserSetting("theme");
    expect(manager.getHookOrigins()).toEqual([]);
    manager.load(undefined, readonlyOrigins);
    manager.mutateSettingsForScope("user", cwd, (data) => {
      data.theme = "dark";
    });
    expect(manager.getHookOrigins()).toEqual([]);
    manager.load(undefined, readonlyOrigins);
    first(manager);
    rmSync(path);
    symlinkSync(join(directory, "missing"), path);
    expect(() => manager.saveUserSetting("theme", "light")).toThrow();
    expect(manager.getHookOrigins()).toEqual([undefined]);
    rmSync(path);
    seed(home, "settings.json", { hooks: [hook("fresh")] });
    manager.load(undefined, readonlyOrigins);
    first(manager);
    manager.invalidate();
    expect(manager.getHookOrigins()).toEqual([]);
    expect(manager.get().hooks?.[0]?.command).toBe("fresh");
    expect(manager.getHookOrigins()).toEqual([undefined]);
  });

  test("flag hooks, invalid validation and caller-mutated Hook data cannot borrow origins", () => {
    seed(home, "settings.json", { hooks: [hook("user")] });
    const manager = load();
    manager.load({ hooks: [hook("flag")] }, readonlyOrigins);
    expect(manager.getHookOrigins().map((origin) => origin?.layer)).toEqual(["user", undefined]);
    manager.get().hooks![0]!.command = "changed-after-validation";
    expect(manager.getHookOrigins()).toEqual([undefined, undefined]);
    seed(home, "settings.json", { hooks: [{ event: "pre_tool_use", command: 42 }] });
    expect(() => manager.load(undefined, readonlyOrigins)).toThrow();
    expect(manager.getHookOrigins()).toEqual([]);
  });

  test("invalid UTF-8 retains ordinary replacement decoding with unavailable new origins", () => {
    const path = join(home, ".code-shell", "settings.json");
    const bytes = Buffer.concat([
      Buffer.from('{"hooks":[{"event":"pre_tool_use","command":"'),
      Buffer.from([0xff]),
      Buffer.from('"}]}'),
    ]);
    writeFileSync(path, bytes);
    const ordinary = new SettingsManager(cwd, "full").load(undefined, { persistMigrations: false });
    const manager = load();
    expect(manager.get().hooks).toEqual(ordinary.hooks);
    expect(manager.get().hooks?.[0]?.command).toBe("\ufffd");
    expect(manager.getHookOrigins()).toEqual([undefined]);
    expect(() => readSettingsHookSnapshot(path)).toThrow();
  });

  test("same-byte rename, chmod, symlinks, hardlinks and changed parent custody revoke", () => {
    for (const mutation of ["rename", "chmod", "symlink", "hardlink", "parent"] as const) {
      const path = seed(home, "settings.json", { hooks: [hook(mutation)] });
      const origin = first(load());
      const bytes = readFileSync(path);
      if (mutation === "rename") {
        const replacement = join(directory, "replacement");
        writeFileSync(replacement, bytes, { mode: 0o600 });
        renameSync(replacement, path);
      } else if (mutation === "chmod") chmodSync(path, 0o640);
      else if (mutation === "symlink") {
        rmSync(path);
        const target = join(directory, "symlink-target");
        writeFileSync(target, bytes);
        symlinkSync(target, path);
      } else if (mutation === "hardlink") linkSync(path, join(directory, "hardlink-target"));
      else chmodSync(join(home, ".code-shell"), 0o750);
      expect(() => assertSettingsHookOriginCurrent(origin)).toThrow();
      if (mutation === "symlink" || mutation === "hardlink") {
        expect(() => readSettingsHookSnapshot(path)).toThrow();
      }
      rmSync(path);
      chmodSync(join(home, ".code-shell"), 0o700);
    }
  });

  test("actual concurrent grow/shrink cannot yield a stable descriptor snapshot", async () => {
    const path = join(home, ".code-shell", "settings.json");
    const size = 4 * 1024 * 1024;
    writeFileSync(path, Buffer.alloc(size, 0x20));
    const shared = new SharedArrayBuffer(8);
    const state = new Int32Array(shared);
    const worker = new Worker(
      `
      const { workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const state = new Int32Array(workerData.shared);
      const fd = fs.openSync(workerData.path, 'r+');
      Atomics.store(state, 0, 1);
      while (Atomics.load(state, 0) !== 2) {
        fs.ftruncateSync(fd, workerData.size - 4096);
        fs.writeSync(fd, Buffer.alloc(4096, 0x20), 0, 4096, workerData.size - 4096);
        Atomics.add(state, 1, 1);
      }
      fs.closeSync(fd);
    `,
      { eval: true, workerData: { path, size, shared } },
    );
    try {
      const deadline = Date.now() + 5000;
      while (Atomics.load(state, 0) === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(Atomics.load(state, 0)).toBe(1);
      let unstableCaptures = 0;
      for (let attempt = 0; attempt < 100 && unstableCaptures === 0; attempt++) {
        try {
          readSettingsHookSnapshot(path);
        } catch (error) {
          // Either the opening lstat/fstat or the final descriptor comparison
          // must refuse an actual mutation it observes. Both use real fds.
          if (/changed (?:at open|during capture)/.test(String(error))) unstableCaptures++;
        }
      }
      expect(Atomics.load(state, 1)).toBeGreaterThan(0);
      expect(unstableCaptures).toBeGreaterThan(0);
    } finally {
      Atomics.store(state, 0, 2);
      await worker.terminate();
    }
  }, 15000);
});
