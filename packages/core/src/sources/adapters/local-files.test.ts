import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_FILES_SOURCE_ID,
  listLocalFiles,
  localFilesAdapter,
  localFilesSourceFor,
  resolveUploadTarget,
  uploadsDir,
} from "./local-files.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cs-uploads-"));
  mkdirSync(uploadsDir(cwd), { recursive: true });
  writeFileSync(join(uploadsDir(cwd), "spec.md"), "# spec content\n");
  writeFileSync(join(uploadsDir(cwd), "notes.txt"), "notes content\n");
  writeFileSync(join(cwd, "outside.txt"), "MUST NOT BE READABLE\n");
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("local-files adapter", () => {
  test("derives the implicit source definition from cwd", () => {
    const definition = localFilesSourceFor(cwd);

    expect(definition).toMatchObject({
      id: LOCAL_FILES_SOURCE_ID,
      kind: "local-files",
      label: "项目文件",
      adapterConfig: {},
      enabled: true,
    });
    expect(uploadsDir(cwd)).toBe(join(cwd, ".code-shell", "uploads"));
  });

  test("exposes one uploads scope and lists file metadata through the cwd helper", async () => {
    const definition = localFilesSourceFor(cwd);

    expect(await localFilesAdapter.listScopes(definition)).toEqual([
      { id: "uploads", label: "上传文件" },
    ]);
    expect(listLocalFiles(cwd)).toEqual([
      { id: "notes.txt", scopeId: "uploads", name: "notes.txt", sizeBytes: 14 },
      { id: "spec.md", scopeId: "uploads", name: "spec.md", sizeBytes: 15 },
    ]);
  });

  test("reads content, canonicalizes the resource id, and truncates by bytes", async () => {
    const definition = localFilesSourceFor(cwd);

    expect(
      await localFilesAdapter.read(definition, "./%73pec.md", { maxBytes: 10_000, cwd }),
    ).toEqual({ resourceId: "spec.md", text: "# spec content\n", truncated: false });
    expect(await localFilesAdapter.read(definition, "spec.md", { maxBytes: 4, cwd })).toEqual({
      resourceId: "spec.md",
      text: "# sp",
      truncated: true,
    });
  });

  test("rejects parent, URL-encoded, absolute, and nested path escapes", async () => {
    const definition = localFilesSourceFor(cwd);
    const attempts = [
      "../outside.txt",
      "..%2Foutside.txt",
      "%2e%2e%2foutside.txt",
      join(cwd, "outside.txt"),
      "nested/../../outside.txt",
    ];

    for (const resourceId of attempts) {
      await expect(
        localFilesAdapter.read(definition, resourceId, { maxBytes: 100, cwd }),
      ).rejects.toThrow(/uploads|resource|path/i);
    }
  });

  test("rejects a symlink whose final target escapes uploads", async () => {
    const definition = localFilesSourceFor(cwd);
    symlinkSync(join(cwd, "outside.txt"), join(uploadsDir(cwd), "escape.txt"));

    await expect(
      localFilesAdapter.read(definition, "escape.txt", { maxBytes: 100, cwd }),
    ).rejects.toThrow(/escapes uploads/i);
  });

  test("returns an empty list when the uploads directory is missing", () => {
    rmSync(uploadsDir(cwd), { recursive: true, force: true });

    expect(listLocalFiles(cwd)).toEqual([]);
  });
});

describe("resolveUploadTarget", () => {
  test("resolves a plain basename inside the uploads dir", () => {
    expect(resolveUploadTarget(cwd, "notes.md")).toBe(join(uploadsDir(cwd), "notes.md"));
  });

  for (const bad of [
    "../escape.md",
    "a/b.md",
    "a\\b.md",
    ".hidden",
    "%2e%2e%2fescape.md",
    "nul\0l.md",
    "",
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => resolveUploadTarget(cwd, bad)).toThrow(/invalid upload name/);
    });
  }
});
