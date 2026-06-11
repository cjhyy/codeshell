/**
 * Model catalog merge (built-in A ∪ user B) + lookup helpers.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMergedCatalog, loadUserCatalog, findCatalogEntry, BUILTIN_CATALOG } from "./index.js";

let homeDir: string;
const realHome = process.env.HOME;

function writeUserCatalog(entries: unknown): void {
  mkdirSync(join(homeDir, ".code-shell"), { recursive: true });
  writeFileSync(join(homeDir, ".code-shell", "model-catalog.user.json"), JSON.stringify(entries));
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "catalog-home-"));
  process.env.HOME = homeDir;
});
afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

describe("getMergedCatalog", () => {
  test("returns built-in entries when no user file", () => {
    const merged = getMergedCatalog();
    expect(merged.length).toBe(BUILTIN_CATALOG.length);
    expect(merged.some((e) => e.id === "openai-images")).toBe(true);
    expect(merged.some((e) => e.id === "fal-video")).toBe(true);
  });

  test("user entry with a new id is appended", () => {
    writeUserCatalog([
      {
        id: "my-image",
        tag: "image",
        adapterKind: "openai",
        displayName: "My Image",
        description: "custom",
        defaultBaseUrl: "https://x.test/v1",
      },
    ]);
    const merged = getMergedCatalog();
    expect(merged.length).toBe(BUILTIN_CATALOG.length + 1);
    expect(merged.find((e) => e.id === "my-image")?.displayName).toBe("My Image");
  });

  test("user entry with same id overrides built-in", () => {
    writeUserCatalog([
      {
        id: "openai-images",
        tag: "image",
        adapterKind: "openai",
        displayName: "OVERRIDDEN",
        description: "x",
        defaultBaseUrl: "https://x.test/v1",
      },
    ]);
    const merged = getMergedCatalog();
    expect(merged.length).toBe(BUILTIN_CATALOG.length);
    expect(merged.find((e) => e.id === "openai-images")?.displayName).toBe("OVERRIDDEN");
  });

  test("invalid user file is ignored (built-in still works)", () => {
    writeUserCatalog([{ id: "bad", tag: "nope" }]);
    expect(loadUserCatalog()).toEqual([]);
    expect(getMergedCatalog().length).toBe(BUILTIN_CATALOG.length);
  });
});

describe("findCatalogEntry", () => {
  test("by exact id", () => {
    const e = findCatalogEntry(BUILTIN_CATALOG, "fal-video");
    expect(e?.adapterKind).toBe("fal");
  });
  test("falls back to adapterKind when id missing (legacy instance)", () => {
    const e = findCatalogEntry(BUILTIN_CATALOG, undefined, "openai");
    expect(e?.id).toBe("openai-images");
  });
  test("paramsDoc is present for built-in entries", () => {
    expect(findCatalogEntry(BUILTIN_CATALOG, "openai-images")?.paramsDoc).toBeTruthy();
    expect(findCatalogEntry(BUILTIN_CATALOG, "fal-video")?.paramsDoc).toBeTruthy();
  });
});
