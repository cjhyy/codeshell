import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localFilesAdapter, localFilesSourceFor, uploadsDir } from "../adapters/local-files.js";
import { listSourcesTool, readSourceTool } from "../../tool-system/builtin/sources.js";
import { saveWorkspaceProfile } from "../../profile/store.js";
import { HookRegistry } from "../../hooks/registry.js";
import { PermissionClassifier } from "../../tool-system/permission.js";
import { ToolExecutor } from "../../tool-system/executor.js";
import { ToolRegistry } from "../../tool-system/registry.js";
import type { ToolContext } from "../../tool-system/context.js";
import { officeZip, wordXml } from "../../../../../tests/fixtures/upload-documents.mjs";
import { invalidateUploadedDocumentIndex, loadUploadedDocumentIndex } from "./index-store.js";

let cwd: string;
let previousHome: string | undefined;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "codeshell-document-index-"));
  previousHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = cwd;
  mkdirSync(uploadsDir(cwd), { recursive: true });
  writeFileSync(
    join(uploadsDir(cwd), "brief.md"),
    "# 项目计划\nDocumentation roadmap\n" +
      "Routine context. ".repeat(500) +
      "\n预算复核 deadline milestone\n",
  );
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(cwd, { recursive: true, force: true });
});
const context = () => ({ cwd, settingsScope: "full" }) as ToolContext;
const queryArgs = (extra = {}) => ({
  source: "project-uploads",
  scope: "uploads",
  resource: "brief.md",
  query: "预算复核",
  ...extra,
});
const read = (extra = {}, options = {}) =>
  localFilesAdapter.read(localFilesSourceFor(cwd), "brief.md", {
    cwd,
    maxBytes: 262_144,
    ...extra,
    ...options,
  });
const legacyRoot = () => join(cwd, ".code-shell", "source-index");
const legacyName = (resourceId: string) =>
  `${createHash("sha256").update(resourceId).digest("hex")}.json`;

test("metadata and approved query/chunk reads create no derived disk files", async () => {
  expect(await listSourcesTool({}, context())).not.toContain("Documentation roadmap");
  expect(existsSync(join(cwd, ".code-shell", "source-index"))).toBe(false);
  const first = JSON.parse((await read({ query: "预算复核", limit: 1 })).text);
  expect(first.matches).toHaveLength(1);
  expect(first.matches[0].text).toContain("预算复核 deadline");
  expect(first.hasMore).toBe(false);
  const second = JSON.parse((await read({ query: "milestone", limit: 1 })).text);
  expect(second.matches[0].id).toBe(first.matches[0].id);
  const chunk = JSON.parse((await read({ chunk: first.matches[0].id })).text);
  expect(chunk.sourceHash).toBe(first.sourceHash);
  expect(chunk.text).toContain("预算复核");
  expect(readdirSync(join(cwd, ".code-shell"))).toEqual(["uploads"]);
});

test("overwrite invalidates content even with restored size/mtime and rejects old chunk citations", async () => {
  const first = JSON.parse((await read({ query: "milestone" })).text);
  const file = join(uploadsDir(cwd), "brief.md");
  const info = statSync(file);
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace("milestone", "replaced!"));
  utimesSync(file, info.atime, info.mtime);
  const second = JSON.parse((await read({ query: "replaced" })).text);
  expect(second.sourceHash).not.toBe(first.sourceHash);
  expect(second.matches[0].text).not.toContain("milestone");
  await expect(read({ chunk: first.matches[0].id })).rejects.toThrow("current file version");
  expect(JSON.parse((await read({ query: "milestone" })).text).matches).toEqual([]);
});

test("deleted originals, query parameter expansion and stale caches cannot expose content", async () => {
  await read({ query: "milestone" });
  writeFileSync(join(uploadsDir(cwd), "other.txt"), "Another listed resource");
  rmSync(join(uploadsDir(cwd), "brief.md"));
  const output = await readSourceTool(queryArgs(), context());
  expect(output).toContain("not listed");
  expect(output).not.toContain("Routine context");
  expect(await readSourceTool(queryArgs({ resource: "../brief.md" }), context())).toContain(
    "not listed",
  );
  expect(await readSourceTool(queryArgs({ query: " ", limit: 0 }), context())).toContain("query");
});

test("Profile and exact ReadSource resource denies also protect already indexed queries", async () => {
  await read({ query: "milestone" });
  saveWorkspaceProfile({
    name: "blocked",
    label: "Blocked",
    basePreset: "general",
    sourceAccess: [],
  });
  expect(
    await readSourceTool(queryArgs(), { ...context(), workspaceProfileName: "blocked" }),
  ).toContain("not bound");
  const executor = new ToolExecutor(
    new ToolRegistry({ builtinTools: ["ReadSource"] }),
    new PermissionClassifier([
      { tool: "ReadSource", argsPattern: { resource: "brief.md" }, decision: "deny" },
      { tool: "ReadSource", decision: "allow" },
    ]),
    new HookRegistry(),
  );
  executor.setContext(context());
  const result = await executor.executeSingle({
    id: "blocked-file",
    toolName: "ReadSource",
    args: queryArgs(),
  });
  expect(result.isError).toBe(true);
  expect(result.error).toContain("Permission denied");
});

test("revocation or replacement while the real parser runs publishes neither result nor index", async () => {
  writeFileSync(join(uploadsDir(cwd), "brief.md"), "Original context ".repeat(50_000));
  let allowed = true;
  const pending = read(
    {},
    {
      assertAuthorized: () => {
        if (!allowed) throw new Error("Authorization revoked");
      },
    },
  );
  allowed = false;
  await expect(pending).rejects.toThrow("Authorization revoked");
  expect(existsSync(join(cwd, ".code-shell", "source-index"))).toBe(false);
  const replacement = read();
  writeFileSync(join(uploadsDir(cwd), "brief.md"), "New document");
  await expect(replacement).rejects.toThrow("changed during parsing");
  expect(existsSync(join(cwd, ".code-shell", "source-index"))).toBe(false);
});

test("unwritable legacy indexes, malformed bytes and unknown files are untouched by reads and invalidation", async () => {
  const originalPath = join(uploadsDir(cwd), "brief.md");
  const original = readFileSync(originalPath);
  const parsed = await loadUploadedDocumentIndex(cwd, "brief.md", original, {
    assertCurrent: () => {},
  });
  mkdirSync(legacyRoot());
  const forged = JSON.parse(JSON.stringify(parsed));
  forged.chunks.forEach((chunk) => (chunk.text = `FORGED ${chunk.text}`));
  const entries = {
    [legacyName("brief.md")]: JSON.stringify(forged),
    "broken.json": "{not JSON",
    "large.json": "x".repeat(9 * 1024 * 1024),
    "user-notes.txt": "Unknown user-owned file; keep",
  };
  for (const [name, bytes] of Object.entries(entries))
    writeFileSync(join(legacyRoot(), name), bytes, { mode: 0o400 });
  if (process.platform !== "win32") chmodSync(legacyRoot(), 0o500);
  try {
    invalidateUploadedDocumentIndex(cwd, "brief.md");
    const output = await read({ query: "milestone" });
    expect(output.text).toContain("milestone");
    expect(output.text).not.toContain("FORGED");
    invalidateUploadedDocumentIndex(cwd, "brief.md");
    for (const [name, bytes] of Object.entries(entries))
      expect(readFileSync(join(legacyRoot(), name), "utf8")).toBe(bytes);
    expect(readdirSync(legacyRoot()).sort()).toEqual(Object.keys(entries).sort());
    expect(readFileSync(originalPath)).toEqual(original);
  } finally {
    if (process.platform !== "win32") chmodSync(legacyRoot(), 0o700);
  }
});

test("a regular file at the legacy directory path cannot block a real original read", async () => {
  writeFileSync(legacyRoot(), "Legacy path is not a directory");
  expect((await read({ query: "milestone" })).text).toContain("milestone");
  invalidateUploadedDocumentIndex(cwd, "brief.md");
  expect(readFileSync(legacyRoot(), "utf8")).toBe("Legacy path is not a directory");
});

test("legacy directory links and hard-linked unknown files are preserved", async () => {
  if (process.platform === "win32") return;
  const outside = mkdtempSync(join(tmpdir(), "codeshell-index-outside-"));
  try {
    const original = join(uploadsDir(cwd), "brief.md");
    const originalBytes = readFileSync(original);
    const bytes = Buffer.from("Unknown legacy content: keep both hard links");
    const unknown = join(outside, "unknown-original.bin");
    writeFileSync(unknown, bytes);
    const linked = join(outside, legacyName("brief.md"));
    linkSync(unknown, linked);
    const before = statSync(linked);
    symlinkSync(outside, legacyRoot());
    expect((await read({ query: "milestone" })).text).toContain("milestone");
    invalidateUploadedDocumentIndex(cwd, "brief.md");
    expect(lstatSync(legacyRoot()).isSymbolicLink()).toBe(true);
    expect(readFileSync(linked)).toEqual(bytes);
    expect(readFileSync(unknown)).toEqual(bytes);
    expect(readFileSync(original)).toEqual(originalBytes);
    expect(statSync(linked).ino).toBe(before.ino);
    expect(statSync(linked).nlink).toBe(before.nlink);
    expect(readdirSync(outside).sort()).toEqual(
      [legacyName("brief.md"), "unknown-original.bin"].sort(),
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("real Office search keeps filename provenance, redaction and untrusted wrapping", async () => {
  const token = "sk-proj-" + "s".repeat(60);
  writeFileSync(
    join(uploadsDir(cwd), "brief.docx"),
    officeZip({ "word/document.xml": wordXml(`预算计划 OPENAI_API_KEY=${token}`) }),
  );
  const result = await readSourceTool(
    queryArgs({ resource: "brief.docx", query: "预算计划" }),
    context(),
  );
  expect(result).toContain("预算计划");
  expect(result).toContain("resource=brief.docx");
  expect(result).toContain("untrusted");
  expect(result).not.toContain(token);
});

test("same bytes in a replacement uploads directory do not satisfy a pending original read", async () => {
  const original = readFileSync(join(uploadsDir(cwd), "brief.md"));
  const pending = read();
  renameSync(uploadsDir(cwd), join(cwd, ".code-shell", "old-uploads"));
  mkdirSync(uploadsDir(cwd));
  writeFileSync(join(uploadsDir(cwd), "brief.md"), original);
  await expect(pending).rejects.toThrow("changed during parsing");
  expect(existsSync(join(cwd, ".code-shell", "source-index"))).toBe(false);
});

test("an atomically replaced original with the same bytes and timestamps cannot satisfy a pending read", async () => {
  await read();
  const path = join(uploadsDir(cwd), "brief.md");
  const before = statSync(path);
  const replacement = join(uploadsDir(cwd), "replacement.tmp");
  writeFileSync(replacement, readFileSync(path));
  utimesSync(replacement, before.atime, before.mtime);
  const pending = read();
  renameSync(replacement, path);
  await expect(pending).rejects.toThrow("changed during parsing");
  expect(existsSync(legacyRoot())).toBe(false);
});

test("cancelled cold and warm reads cannot return cached content or create disk files", async () => {
  const controller = new AbortController();
  const pending = read({}, { signal: controller.signal });
  controller.abort(new Error("Cancelled fixture read"));
  await expect(pending).rejects.toThrow("Cancelled fixture read");
  expect((await read({ query: "milestone" })).text).toContain("milestone");
  // Cancellation must deny content even on runtimes with a different abort reason.
  expect(
    await read({}, { signal: controller.signal }).then(
      () => false,
      () => true,
    ),
  ).toBe(true);
  const warm = new AbortController();
  const pendingWarm = read({}, { signal: warm.signal });
  warm.abort(new Error("Cancelled warm read"));
  expect(
    await pendingWarm.then(
      () => false,
      () => true,
    ),
  ).toBe(true);
  expect(readdirSync(join(cwd, ".code-shell"))).toEqual(["uploads"]);
});

test("revocation after a warm read starts is checked before any cached content returns", async () => {
  await read();
  let authorized = true;
  const pending = read(
    {},
    {
      assertAuthorized: () => {
        if (!authorized) throw new Error("Fixture resource revoked");
      },
    },
  );
  authorized = false;
  await expect(pending).rejects.toThrow("Fixture resource revoked");
  expect(existsSync(legacyRoot())).toBe(false);
});

function realIndex(resourceId: string, text = "Cache fixture milestone", workspace = cwd) {
  const path = join(uploadsDir(workspace), resourceId);
  const bytes = Buffer.from(text);
  if (!existsSync(path)) writeFileSync(path, bytes);
  return loadUploadedDocumentIndex(workspace, resourceId, bytes, {
    assertCurrent: () => {
      if (!readFileSync(path).equals(bytes)) throw new Error("Fixture original changed");
    },
  });
}

test("the 32-entry LRU reparses an evicted original and preserves a recently used entry", async () => {
  const indexes = [];
  for (let i = 0; i < 32; i++) indexes.push(await realIndex(`entry-${i}.txt`));
  expect(await realIndex("entry-0.txt")).toBe(indexes[0]);
  await realIndex("overflow.txt");
  expect(await realIndex("entry-1.txt")).not.toBe(indexes[1]);
  expect(await realIndex("entry-0.txt")).toBe(indexes[0]);
  expect(existsSync(legacyRoot())).toBe(false);
}, 30_000);

test("the byte budget evicts before the entry cap and invalidation affects only the exact workspace/resource", async () => {
  const text = "Budget milestone ".repeat(40_000);
  const first = await realIndex("large-0.txt", text);
  let bytes = Buffer.byteLength(JSON.stringify(first));
  let count = 1;
  while (bytes <= 8 * 1024 * 1024) {
    const index = await realIndex(`large-${count++}.txt`, text);
    bytes += Buffer.byteLength(JSON.stringify(index));
  }
  expect(count).toBeLessThan(32);
  expect(await realIndex("large-0.txt", text)).not.toBe(first);
  const kept = await realIndex("kept.txt");
  const invalidated = await realIndex("invalidate.txt");
  expect(Object.isFrozen(invalidated)).toBe(true);
  expect(Object.isFrozen(invalidated.chunks)).toBe(true);
  expect(Object.isFrozen(invalidated.chunks[0])).toBe(true);
  const other = mkdtempSync(join(tmpdir(), "codeshell-index-workspace-"));
  try {
    mkdirSync(uploadsDir(other), { recursive: true });
    const otherIndex = await realIndex("invalidate.txt", "Cache fixture milestone", other);
    expect(otherIndex).not.toBe(invalidated);
    if (process.platform !== "win32") {
      const alias = join(other, "alias");
      symlinkSync(cwd, alias);
      expect(await realIndex("invalidate.txt", "Cache fixture milestone", alias)).toBe(invalidated);
    }
    invalidateUploadedDocumentIndex(join(cwd, "."), "invalidate.txt");
    expect(await realIndex("invalidate.txt")).not.toBe(invalidated);
    expect(await realIndex("kept.txt")).toBe(kept);
    expect(await realIndex("invalidate.txt", "Cache fixture milestone", other)).toBe(otherIndex);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
  expect(existsSync(legacyRoot())).toBe(false);
}, 30_000);

test("successive external deletions and new document names leave no derived disk history", async () => {
  for (let i = 0; i < 35; i++) {
    const name = `temporary-${i}.txt`;
    await realIndex(name);
    rmSync(join(uploadsDir(cwd), name));
  }
  expect(readdirSync(join(cwd, ".code-shell"))).toEqual(["uploads"]);
}, 30_000);
