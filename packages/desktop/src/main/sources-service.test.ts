import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    catalogSave({ id: "zeta", kind: "mock", label: "Zeta" });
    catalogSave({ id: "alpha", kind: "mock", label: "Alpha", enabled: false });

    expect(catalogList().map((definition) => definition.id)).toEqual(["alpha", "zeta"]);
    expect(catalogList()[0]).toMatchObject({ adapterConfig: {}, enabled: false });

    catalogDelete("alpha");
    expect(catalogList().map((definition) => definition.id)).toEqual(["zeta"]);
  });

  test("bind/unbind updates workspace bindings and effective access", () => {
    catalogSave({ id: "research", kind: "mock", label: "Research" });

    bind(cwd, { sourceId: "research", scopes: ["alpha"], readPolicy: "ask" });

    const bound = workspaceAccess(cwd);
    expect(bound.bindings).toEqual([
      { sourceId: "research", scopes: ["alpha"], readPolicy: "ask" },
    ]);
    expect(bound.access.find((item) => item.sourceId === "research")).toMatchObject({
      label: "Research",
      kind: "mock",
      scopes: ["alpha"],
      status: "ok",
    });

    unbind(cwd, "research");
    expect(workspaceAccess(cwd).bindings).toEqual([]);
    expect(workspaceAccess(cwd).access).toEqual([]);
  });

  test("lists adapter scopes for a catalog source", async () => {
    catalogSave({ id: "research", kind: "mock", label: "Research" });

    expect(await listScopes("research")).toEqual([
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
    ]);
    await expect(listScopes("missing")).rejects.toThrow(/source.*missing/i);
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
});
