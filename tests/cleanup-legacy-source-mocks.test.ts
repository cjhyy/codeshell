import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

if (!process.env.HOME || !process.env.CODE_SHELL_TEST_HOME)
  throw new Error("Run through the guarded Bun runner with a private HOME");
const surfaces = [
  [globalThis, "fetch"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
  [net, "connect"],
  [net, "createConnection"],
  [net.Socket.prototype, "connect"],
  [tls, "connect"],
] as const;
const saved = surfaces.map(([object, key]) => ({
  object,
  key,
  descriptor: Object.getOwnPropertyDescriptor(object, key),
}));
const deny = () => {
  throw new Error("Cleanup fixture denied network");
};
for (const { object, key } of saved) Reflect.set(object, key, deny);
syncBuiltinESMExports();
afterAll(() => {
  for (const { object, key, descriptor } of saved) {
    if (Reflect.get(object, key) !== deny)
      throw new Error("Cleanup fixture lost network guard ownership");
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  }
  syncBuiltinESMExports();
});
expect(() => fetch("https://cleanup.invalid/")).toThrow("denied network");
expect(() => net.connect(443, "cleanup.invalid")).toThrow("denied network");

// The exact network denial is installed before importing Core's lock helper.
const { cleanupLegacySourceMocks } = await import("../scripts/cleanup-legacy-source-mocks.js");
let root: string;
let home: string;
let project: string;
let catalog: string;
let settings: string;
let localSettings: string;
let profile: string;

function json(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function read(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function source(id: string, kind = "mock") {
  return { id, kind, label: id, unknown: { keep: true } };
}
function binding(sourceId: string) {
  return { sourceId, scopes: [], readPolicy: "deny", extra: "keep" };
}
function run(apply = false) {
  return cleanupLegacySourceMocks({ home, projects: [project], apply });
}
function backups(path: string) {
  return readdirSync(join(path, "..")).filter((name) => name.includes(".legacy-mocks."));
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(process.env.HOME!), "source-cleanup-"));
  home = join(root, "app");
  project = join(root, "project");
  catalog = join(home, "sources.json");
  settings = join(project, ".code-shell", "settings.json");
  localSettings = join(project, ".code-shell", "settings.local.json");
  profile = join(home, "profiles", "assistant", "profile.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("dry run leaves bytes untouched; apply backs up exact bytes and preserves real/unknown data", () => {
  json(catalog, {
    version: 1,
    sources: [source("old"), source("mock-production", "link"), source("files", "collection")],
    envelope: { keep: true },
  });
  json(settings, {
    sources: [binding("old"), binding("mock-production"), binding("dangling")],
    unrelated: { secret: "test-only-value" },
  });
  json(localSettings, { sources: [binding("old")], unknown: [1, 2, 3] });
  json(profile, { name: "assistant", sourceAccess: [binding("old")], unknown: { keep: true } });
  const paths = [catalog, settings, localSettings, profile];
  const original = paths.map((path) => readFileSync(path));
  expect(run()).toMatchObject({ mode: "dry-run", sourceRecords: 1, sourceReferences: 3 });
  paths.forEach((path, index) => {
    expect(readFileSync(path)).toEqual(original[index]);
    expect(backups(path)).toHaveLength(0);
  });
  const result = run(true);
  expect(result).toMatchObject({ mode: "apply", sourceRecords: 1, sourceReferences: 3 });
  expect(JSON.stringify(result)).not.toContain("test-only-value");
  expect(read(catalog)).toEqual({
    version: 1,
    sources: [source("mock-production", "link"), source("files", "collection")],
    envelope: { keep: true },
  });
  expect(read(settings)).toEqual({
    sources: [binding("mock-production"), binding("dangling")],
    unrelated: { secret: "test-only-value" },
  });
  expect(read(localSettings)).toEqual({ sources: [], unknown: [1, 2, 3] });
  expect(read(profile)).toEqual({ name: "assistant", sourceAccess: [], unknown: { keep: true } });
  for (const changed of result.files) {
    const index = paths.indexOf(changed.path);
    expect(readFileSync(changed.backup!)).toEqual(original[index]);
    expect(statSync(changed.backup!).mode & 0o777).toBe(0o600);
  }
  const mtimes = paths.map((path) => statSync(path).mtimeMs);
  const second = run(true);
  expect(second).toMatchObject({ mode: "apply", sourceRecords: 0, sourceReferences: 0, files: [] });
  paths.forEach((path, index) => {
    expect(statSync(path).mtimeMs).toBe(mtimes[index]);
    expect(backups(path)).toHaveLength(path === settings || path === localSettings ? 2 : 1);
  });
});

test("duplicate mock+real ID keeps the real source's bindings in either order", () => {
  for (const sources of [
    [source("shared"), source("shared", "link")],
    [source("shared", "link"), source("shared")],
  ]) {
    json(catalog, { version: 1, sources });
    json(settings, { sources: [binding("shared")] });
    json(profile, { sourceAccess: [binding("shared")] });
    const bytes = [readFileSync(settings), readFileSync(profile)];
    expect(run(true)).toMatchObject({ sourceRecords: 1, sourceReferences: 0 });
    expect(read(catalog).sources).toEqual([source("shared", "link")]);
    expect(readFileSync(settings)).toEqual(bytes[0]);
    expect(readFileSync(profile)).toEqual(bytes[1]);
  }
});

test("no-op creates no home, missing settings, or backups and preserves explicit deny []", () => {
  expect(run(true).files).toEqual([]);
  expect(existsSync(home)).toBe(false);
  expect(existsSync(project)).toBe(false);
  json(catalog, { version: 1, sources: [source("demo", "collection")] });
  json(profile, { sourceAccess: [] });
  const bytes = readFileSync(profile);
  expect(run(true).files).toEqual([]);
  expect(readFileSync(profile)).toEqual(bytes);
  expect(existsSync(settings)).toBe(false);
  expect(backups(catalog)).toEqual([]);
  expect(backups(profile)).toEqual([]);
});

test("bounded registered project discovery uses V2 roots and ignores stale recents", () => {
  const other = join(root, "other");
  json(catalog, { version: 1, sources: [source("old")] });
  json(settings, { sources: [binding("old")] });
  json(join(other, ".code-shell", "settings.json"), { sources: [binding("old")] });
  json(join(home, "desktop", "projects.json"), {
    version: 2,
    projects: [{ roots: [{ path: project }] }],
  });
  json(join(home, "desktop", "recents.json"), [{ path: other }]);
  expect(cleanupLegacySourceMocks({ home, registeredProjects: true, apply: true })).toMatchObject({
    sourceRecords: 1,
    sourceReferences: 1,
  });
  expect(read(settings).sources).toEqual([]);
  expect(read(join(other, ".code-shell", "settings.json")).sources).toEqual([binding("old")]);
});

test("registered project discovery supports the actual recents fallback only when V2 is absent", () => {
  json(catalog, { version: 1, sources: [source("old")] });
  json(settings, { sources: [binding("old")] });
  json(join(home, "desktop", "recents.json"), [{ path: project }]);
  expect(cleanupLegacySourceMocks({ home, registeredProjects: true }).sourceReferences).toBe(1);
  json(join(home, "desktop", "projects.json"), { version: 1, projects: [] });
  expect(() => cleanupLegacySourceMocks({ home, registeredProjects: true, apply: true })).toThrow(
    "Invalid project registry",
  );
  expect(read(catalog).sources).toHaveLength(1);
});

test("repeated explicit and registered project paths are inspected and changed only once", () => {
  json(catalog, { version: 1, sources: [source("old")] });
  json(settings, { sources: [binding("old")] });
  json(join(home, "desktop", "projects.json"), {
    version: 2,
    projects: [{ roots: [{ path: project }] }],
  });
  const result = cleanupLegacySourceMocks({
    home,
    projects: [project, join(project, "..", "project")],
    registeredProjects: true,
    apply: true,
  });
  expect(result).toMatchObject({
    inspected: { projectRoots: 1, projectSettingsFiles: 1 },
    sourceRecords: 1,
    sourceReferences: 1,
  });
  expect(result.files).toHaveLength(2);
  expect(backups(settings)).toHaveLength(1);
});

test("corrupt reference JSON aborts before any writes or backups and reports no payload", () => {
  json(catalog, { version: 1, sources: [source("old")] });
  json(settings, { sources: [binding("old")] });
  writeFileSync(localSettings, '{"secret":"should-not-appear" broken');
  const bytes = readFileSync(catalog);
  expect(() => run(true)).toThrow(`Invalid JSON; left unchanged: ${localSettings}`);
  expect(readFileSync(catalog)).toEqual(bytes);
  expect(read(settings).sources).toEqual([binding("old")]);
  expect(backups(catalog)).toEqual([]);
  expect(backups(settings)).toEqual([]);
});

test("corrupt, oversized, and hardlinked catalogs remain untouched", () => {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const text of ["not-json", " ".repeat(4 * 1024 * 1024 + 1)]) {
    writeFileSync(catalog, text);
    expect(() => run(true)).toThrow();
    expect(readFileSync(catalog, "utf8")).toBe(text);
    expect(backups(catalog)).toEqual([]);
  }
  json(catalog, { version: 1, sources: [source("old")] });
  linkSync(catalog, join(home, "other.json"));
  expect(() => run(true)).toThrow("bounded regular file");
  expect(read(catalog).sources).toHaveLength(1);
});

test("symlinked target files and state directories abort without editing their destination", () => {
  json(catalog, { version: 1, sources: [source("old")] });
  const outside = join(root, "outside.json");
  json(outside, { sources: [binding("old")] });
  mkdirSync(join(project, ".code-shell"), { recursive: true });
  symlinkSync(outside, settings);
  expect(() => run(true)).toThrow("Symbolic links");
  expect(read(outside).sources).toEqual([binding("old")]);
  expect(read(catalog).sources).toHaveLength(1);
  rmSync(join(project, ".code-shell"), { recursive: true });
  const outsideDir = join(root, "outside-dir");
  json(join(outsideDir, "settings.json"), { sources: [binding("old")] });
  symlinkSync(outsideDir, join(project, ".code-shell"));
  expect(() => run(true)).toThrow("Symbolic links");
  expect(read(catalog).sources).toHaveLength(1);
  expect(backups(catalog)).toEqual([]);
});
