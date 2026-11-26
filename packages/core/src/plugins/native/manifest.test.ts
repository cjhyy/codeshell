import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectPluginSource } from "../installer/projectPluginSource.js";
import {
  diffNativeSurface,
  NATIVE_PLUGIN_API_VERSION,
  nativeContextKey,
  nativeModuleId,
  nativeNamingProblem,
  nativePluginSurface,
  nativeScopedName,
  nativeToolName,
  parseNativePluginManifest,
  readNativePluginManifest,
  type NativePluginManifest,
} from "./manifest.js";

const minimal = { schemaVersion: 2, apiVersion: 1, main: "./dist/index.js" };

function manifestOf(raw: unknown): NativePluginManifest {
  const read = parseNativePluginManifest(raw);
  if (read.kind !== "native") throw new Error(JSON.stringify(read));
  return read.manifest;
}

describe("native plugin manifest", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "native-manifest-"));
    mkdirSync(join(root, ".codeshell-plugin"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.js"), "export default { setup() {} };\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(raw: unknown): void {
    writeFileSync(join(root, ".codeshell-plugin", "plugin.json"), JSON.stringify(raw));
  }

  test("a directory without the CodeShell manifest, or with the v1 overlay, is not native", () => {
    expect(readNativePluginManifest(join(root, "dist"))).toEqual({ kind: "none" });
    write({ schemaVersion: 1 });
    expect(readNativePluginManifest(root)).toEqual({ kind: "none" });
  });

  test("fills every contribution list with an empty default", () => {
    write(minimal);
    expect(readNativePluginManifest(root)).toEqual({
      kind: "native",
      manifest: {
        schemaVersion: 2,
        apiVersion: 1,
        main: "./dist/index.js",
        contributes: {
          hooks: [],
          tools: [],
          presets: [],
          promptSections: [],
          context: [],
          background: false,
        },
        coreCapabilities: [],
        hostCapabilities: [],
      },
    });
  });

  test("this host's API version is the contract table's", () => {
    expect(NATIVE_PLUGIN_API_VERSION).toBe(1);
  });

  test.each([
    ["a future schema", { ...minimal, schemaVersion: 3 }, "schemaVersion"],
    ["an unknown top-level field", { ...minimal, surprise: true }, "Unrecognized"],
    [
      "an unknown contribution kind",
      { ...minimal, contributes: { queries: ["x"] } },
      "contributes",
    ],
    ["an unknown hook event", { ...minimal, contributes: { hooks: ["on_everything"] } }, "hooks"],
    ["a duplicate tool", { ...minimal, contributes: { tools: ["a", "a"] } }, "duplicate"],
    [
      "a tool name with a double underscore",
      { ...minimal, contributes: { tools: ["a__b"] } },
      "tools",
    ],
    ["an upper-case preset", { ...minimal, contributes: { presets: ["Reviewer"] } }, "presets"],
    ["an entry outside the plugin", { ...minimal, main: "../outside.js" }, "main"],
    ["an absolute entry", { ...minimal, main: "/tmp/outside.js" }, "main"],
    ["a TypeScript entry", { ...minimal, main: "./src/index.ts" }, "main"],
    ["a non-integer API version", { ...minimal, apiVersion: 1.5 }, "apiVersion"],
  ])("rejects %s", (_label, raw, mention) => {
    const read = parseNativePluginManifest(raw);
    expect(read.kind).toBe("invalid");
    expect(read.kind === "invalid" ? read.error : "").toContain(mention);
  });

  test("the entry must be a regular file inside the tree", () => {
    write({ ...minimal, main: "./dist/missing.js" });
    expect(readNativePluginManifest(root)).toMatchObject({ kind: "invalid" });

    const outside = join(root, "outside.js");
    writeFileSync(outside, "export default {};\n");
    symlinkSync(outside, join(root, "dist", "linked.js"));
    write({ ...minimal, main: "./dist/linked.js" });
    const linked = readNativePluginManifest(root);
    expect(linked.kind === "invalid" ? linked.error : "").toContain("regular file");
  });

  test("a symlinked manifest and malformed JSON are invalid, not absent", () => {
    writeFileSync(join(root, "elsewhere.json"), JSON.stringify(minimal));
    symlinkSync(join(root, "elsewhere.json"), join(root, ".codeshell-plugin", "plugin.json"));
    expect(readNativePluginManifest(root)).toMatchObject({ kind: "invalid" });

    rmSync(join(root, ".codeshell-plugin", "plugin.json"));
    writeFileSync(join(root, ".codeshell-plugin", "plugin.json"), "{ not json");
    const malformed = readNativePluginManifest(root);
    expect(malformed.kind === "invalid" ? malformed.error : "").toContain("invalid JSON");
  });

  test("public names carry the plugin name", () => {
    expect(nativeToolName("reviewer", "lookup")).toBe("plugin__reviewer__lookup");
    expect(nativeScopedName("reviewer", "strict")).toBe("reviewer:strict");
    expect(nativeContextKey("reviewer", "repo-status")).toBe("plugin-reviewer-repo-status");
    expect(nativeModuleId("reviewer", "reviewer@market")).toMatch(/^plugin-reviewer-[a-f0-9]{8}$/);
    expect(nativeModuleId("reviewer", "reviewer@market")).not.toBe(
      nativeModuleId("reviewer", "reviewer@other"),
    );
  });

  test("names the plugin name or tool name that cannot become a public name", () => {
    const manifest = manifestOf({ ...minimal, contributes: { tools: ["lookup"] } });
    expect(nativeNamingProblem("reviewer", manifest)).toBeNull();
    expect(nativeNamingProblem("my.plugin", manifest)).toContain("my.plugin");
    expect(nativeNamingProblem("my_plugin", manifest)).toContain("my_plugin");

    const long = manifestOf({ ...minimal, contributes: { tools: ["t".repeat(32)] } });
    expect(nativeNamingProblem("a", long)).toBeNull();
    expect(nativeNamingProblem("p".repeat(32), long)).toContain("longer than 64");
  });

  test("the surface is sorted data and its diff names what an update adds or drops", () => {
    const first = nativePluginSurface(
      manifestOf({
        ...minimal,
        contributes: { hooks: ["pre_tool_use", "on_stop"], tools: ["b", "a"] },
        coreCapabilities: ["llm"],
      }),
    );
    expect(first.hooks).toEqual(["on_stop", "pre_tool_use"]);
    expect(first.tools).toEqual(["a", "b"]);

    expect(diffNativeSurface(undefined, first)).toEqual({
      added: { hooks: ["on_stop", "pre_tool_use"], tools: ["a", "b"], coreCapabilities: ["llm"] },
      removed: {},
    });

    const second = nativePluginSurface(
      manifestOf({
        ...minimal,
        contributes: { hooks: ["pre_tool_use"], tools: ["a", "c"], background: true },
        hostCapabilities: ["notifications"],
      }),
    );
    expect(diffNativeSurface(first, second)).toEqual({
      added: { tools: ["c"], hostCapabilities: ["notifications"] },
      removed: { hooks: ["on_stop"], tools: ["b"], coreCapabilities: ["llm"] },
      background: { from: false, to: true },
    });
    expect(diffNativeSurface(second, second)).toEqual({ added: {}, removed: {} });
  });
});

describe("installing a native plugin", () => {
  let home: string;
  let source: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "native-install-"));
    source = join(home, "source");
    mkdirSync(join(source, ".codeshell-plugin"), { recursive: true });
    mkdirSync(join(source, "dist"));
    writeFileSync(join(source, "dist", "index.js"), "export default { setup() {} };\n");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function write(raw: unknown): void {
    writeFileSync(join(source, ".codeshell-plugin", "plugin.json"), JSON.stringify(raw));
  }

  test("a valid v2 manifest installs and stays readable from the install tree", async () => {
    write({ ...minimal, contributes: { tools: ["lookup"] } });
    const destination = join(home, "installed");
    await projectPluginSource(source, destination, "reviewer");
    expect(readNativePluginManifest(destination)).toMatchObject({
      kind: "native",
      manifest: { contributes: { tools: ["lookup"] } },
    });
  });

  test("an invalid v2 manifest fails the install instead of installing a dead plugin", async () => {
    write({ ...minimal, contributes: { hooks: ["on_everything"] } });
    await expect(projectPluginSource(source, join(home, "installed"), "reviewer")).rejects.toThrow(
      /plugin\.json/,
    );
  });

  test("a plugin name that cannot prefix public names fails the install", async () => {
    write(minimal);
    await expect(projectPluginSource(source, join(home, "installed"), "my.plugin")).rejects.toThrow(
      /my\.plugin/,
    );
  });
});
