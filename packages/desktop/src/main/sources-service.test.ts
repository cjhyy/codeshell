import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bind,
  catalogDelete,
  catalogList,
  catalogSave,
  deleteUpload,
  listScopes,
  unbind,
  uploadFiles,
  workspaceAccess,
} from "./sources-service.js";
import {
  localFilesAdapter,
  localFilesSourceFor,
  saveSourceDefinition,
} from "@cjhyy/code-shell-core/internal";
import { SettingsManager } from "@cjhyy/code-shell-core";

let home: string;
let cwd: string;
let sourceDir: string;
let previousCodeShellHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-desktop-sources-"));
  cwd = join(home, "workspace");
  sourceDir = join(home, "picked", "nested");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  previousCodeShellHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});

afterEach(() => {
  if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousCodeShellHome;
  rmSync(home, { recursive: true, force: true });
});

describe("desktop sources service", () => {
  test("catalog save/list/delete round-trips through the global store", () => {
    catalogSave({ id: "zeta", kind: "mcp-resource", label: "Zeta" });
    catalogSave({ id: "alpha", kind: "mcp-resource", label: "Alpha", enabled: false });

    expect(catalogList().map((definition) => definition.id)).toEqual(["alpha", "zeta"]);
    expect(catalogList()[0]).toMatchObject({ adapterConfig: {}, enabled: false });

    catalogDelete("alpha");
    expect(catalogList().map((definition) => definition.id)).toEqual(["zeta"]);
  });

  test("bind/unbind updates workspace bindings and effective access", () => {
    catalogSave({ id: "research", kind: "mcp-resource", label: "Research" });

    bind(cwd, { sourceId: "research", scopes: ["resources"], readPolicy: "ask" });

    const bound = workspaceAccess(cwd);
    expect(bound.bindings).toEqual([
      { sourceId: "research", scopes: ["resources"], readPolicy: "ask" },
    ]);
    expect(bound.access.find((item) => item.sourceId === "research")).toMatchObject({
      label: "Research",
      kind: "mcp-resource",
      scopes: ["resources"],
      status: "ok",
    });

    unbind(cwd, "research");
    expect(workspaceAccess(cwd).bindings).toEqual([]);
    expect(workspaceAccess(cwd).access).toEqual([]);
  });

  test("lists adapter scopes for a catalog source", async () => {
    catalogSave({ id: "research", kind: "mcp-resource", label: "Research" });

    expect(await listScopes("research")).toEqual([{ id: "resources", label: "Resources" }]);
    await expect(listScopes("missing")).rejects.toThrow(/source.*missing/i);
  });

  test("rejects legacy demo sources at every production editing boundary", async () => {
    expect(() => catalogSave({ id: "demo", kind: "mock", label: "Demo" })).toThrow(/仅用于测试/);
    saveSourceDefinition({
      id: "demo",
      kind: "mock",
      label: "Demo",
      adapterConfig: {},
      enabled: true,
    });
    expect(() => bind(cwd, { sourceId: "demo", scopes: ["alpha"], readPolicy: "ask" })).toThrow(
      /仅用于测试/,
    );
    await expect(listScopes("demo")).rejects.toThrow(/仅用于测试/);
    expect(catalogList()).toEqual([]);
    new SettingsManager(cwd, "full").saveProjectSetting(
      "sources",
      [{ sourceId: "demo", scopes: ["alpha"], readPolicy: "ask" }],
      cwd,
    );
    expect(workspaceAccess(cwd)).toEqual({ bindings: [], access: [], uploads: [] });
    // Explicit deletion remains available for legacy maintenance.
    catalogDelete("demo");
    expect(catalogList()).toEqual([]);
  });

  test("omits exact demo definitions and bindings while retaining real and dangling references", () => {
    saveSourceDefinition({
      id: "demo",
      kind: "mock",
      label: "Demo",
      adapterConfig: {},
      enabled: true,
    });
    catalogSave({
      id: "mock-real-docs",
      kind: "mcp-resource",
      label: "Real docs",
      adapterConfig: { server: "docs" },
      enabled: true,
    });
    new SettingsManager(cwd, "full").saveProjectSetting(
      "sources",
      [
        { sourceId: "demo", scopes: ["alpha"], readPolicy: "ask" },
        { sourceId: "mock-real-docs", scopes: ["resources"], readPolicy: "deny", priority: "high" },
        { sourceId: "removed-real-source", scopes: ["resources"], readPolicy: "deny" },
      ],
      cwd,
    );
    expect(catalogList().map((source) => source.id)).toEqual(["mock-real-docs"]);
    const snapshot = workspaceAccess(cwd);
    expect(snapshot.bindings.map((binding) => binding.sourceId)).toEqual([
      "mock-real-docs",
      "removed-real-source",
    ]);
    expect(snapshot.access.some((access) => access.sourceId === "demo")).toBe(false);
    expect(snapshot.access.find((access) => access.sourceId === "mock-real-docs")).toMatchObject({
      readPolicy: "deny",
      priority: "high",
    });
    expect(
      snapshot.access.find((access) => access.sourceId === "removed-real-source"),
    ).toMatchObject({ status: "dangling" });
  });

  test("copies selected files by basename, lists metadata, overwrites, and deletes", () => {
    const picked = join(sourceDir, "brief.md");
    writeFileSync(picked, "first");

    expect(uploadFiles(cwd, [picked])).toEqual(["brief.md"]);
    const uploaded = join(cwd, ".code-shell", "uploads", "brief.md");
    expect(readFileSync(uploaded, "utf8")).toBe("first");
    expect(workspaceAccess(cwd).uploads).toEqual([
      { id: "brief.md", scopeId: "uploads", name: "brief.md", sizeBytes: 5 },
    ]);

    writeFileSync(picked, "replacement");
    expect(uploadFiles(cwd, [picked])).toEqual(["brief.md"]);
    expect(readFileSync(uploaded, "utf8")).toBe("replacement");

    deleteUpload(cwd, "brief.md");
    expect(existsSync(uploaded)).toBe(false);
    expect(workspaceAccess(cwd).uploads).toEqual([]);
  });

  test("rejects unsafe upload and delete names before touching outside files", () => {
    const hidden = join(sourceDir, ".secret");
    writeFileSync(hidden, "secret");
    expect(() => uploadFiles(cwd, [hidden])).toThrow(/invalid upload name/i);

    const outside = join(cwd, "outside.txt");
    writeFileSync(outside, "keep");
    for (const name of [
      "",
      ".",
      "..",
      ".hidden",
      "../outside.txt",
      "nested/file.txt",
      "nested\\file.txt",
      "%2e%2e%2foutside.txt",
    ]) {
      expect(() => deleteUpload(cwd, name)).toThrow(/invalid upload name/i);
    }
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  test("refuses a symlinked uploads directory instead of writing outside the project", () => {
    if (process.platform === "win32") return;
    const picked = join(sourceDir, "brief.md");
    const outside = join(home, "outside-uploads");
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(cwd, ".code-shell", "uploads"));
    writeFileSync(picked, "private");
    writeFileSync(join(outside, "brief.md"), "keep");

    expect(() => uploadFiles(cwd, [picked])).toThrow(/uploads directory/i);
    expect(() => deleteUpload(cwd, "brief.md")).toThrow(/uploads directory/i);
    expect(readFileSync(join(outside, "brief.md"), "utf8")).toBe("keep");
    expect(workspaceAccess(cwd).uploads).toEqual([]);
  });

  test("atomically overwrites without leaving temporary files", () => {
    const picked = join(sourceDir, "brief.md");
    writeFileSync(picked, "first");
    uploadFiles(cwd, [picked]);
    writeFileSync(picked, "second");
    uploadFiles(cwd, [picked]);

    const root = join(cwd, ".code-shell", "uploads");
    expect(readFileSync(join(root, "brief.md"), "utf8")).toBe("second");
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("overwrite and delete invalidate content without creating or touching legacy indexes", async () => {
    const picked = join(sourceDir, "brief.md");
    writeFileSync(picked, "Project milestone");
    uploadFiles(cwd, [picked]);
    const read = () =>
      localFilesAdapter.read(localFilesSourceFor(cwd), "brief.md", {
        cwd,
        maxBytes: 10_000,
        query: "milestone",
      });
    await read();
    const index = join(cwd, ".code-shell", "source-index");
    expect(existsSync(index)).toBe(false);
    mkdirSync(index);
    const legacy = join(index, "legacy.json");
    writeFileSync(legacy, "Legacy bytes belong to the workspace");
    writeFileSync(picked, "Replacement milestone");
    uploadFiles(cwd, [picked]);
    expect((await read()).text).toContain("Replacement milestone");
    expect(readFileSync(legacy, "utf8")).toBe("Legacy bytes belong to the workspace");
    deleteUpload(cwd, "brief.md");
    await expect(read()).rejects.toThrow("ENOENT");
    expect(readdirSync(index)).toEqual(["legacy.json"]);
    expect(readFileSync(legacy, "utf8")).toBe("Legacy bytes belong to the workspace");
  });
});
