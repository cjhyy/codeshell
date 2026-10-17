import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUploadedDocument } from "../../../packages/core/src/sources/adapters/local-files.ts";
import { documentIndexText } from "../../../packages/core/src/sources/documents/index-store.ts";

test("normal local Unicode extraction reconstructs overlap and exact chunks, then refreshes changed bytes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codeshell-sources-normal-document-"));
  try {
    const uploads = join(cwd, ".code-shell", "uploads");
    mkdirSync(uploads, { recursive: true });
    const path = join(uploads, "brief.md");
    const original = "界".repeat(2_799) + "😀" + " 预算复核 " + "milestone ".repeat(400);
    writeFileSync(path, original);
    const options = { cwd, maxBytes: 262_144 };
    const read = await readUploadedDocument("brief.md", options);
    expect(read.content.text).toBe(original);
    expect(documentIndexText(read.index)).toBe(original);
    expect(read.index.chunks.length).toBeGreaterThan(1);
    expect(read.content.truncated).toBe(false);
    const query = JSON.parse((await readUploadedDocument("brief.md", { ...options, query: "预算复核", limit: 1 })).content.text);
    expect(query.matches).toHaveLength(1);
    const oldId = query.matches[0].id;
    const chunk = JSON.parse((await readUploadedDocument("brief.md", { ...options, chunk: oldId })).content.text);
    expect(chunk.sourceHash).toBe(query.sourceHash);
    expect(chunk.text).toContain("预算复核");
    const changed = original.replace("预算复核", "变更报告");
    writeFileSync(path, changed);
    await expect(readUploadedDocument("brief.md", { ...options, chunk: oldId })).rejects.toThrow("current file version");
    const next = JSON.parse((await readUploadedDocument("brief.md", { ...options, query: "变更报告", limit: 1 })).content.text);
    expect(next.sourceHash).not.toBe(query.sourceHash);
    expect(next.matches).toHaveLength(1);
    console.log(JSON.stringify({ case: "normal-local-document-version", originalBytes: Buffer.byteLength(original), chunks: read.index.chunks.length, oldChunk: oldId, newChunk: next.matches[0].id, reconstructedUnchanged: true, staleChunkRejected: true }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
