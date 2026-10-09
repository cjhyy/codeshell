import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocumentIsolated } from "./worker.js";
import {
  DOCUMENT_PARSER_VERSION,
  MAX_DOCUMENT_CHUNKS,
  type DocumentChunk,
  type DocumentIndex,
  type ParsedDocument,
} from "./types.js";

const CHUNK_SIZE = 3_000;
const CHUNK_OVERLAP = 200;
// Only indexes parsed from original bytes in this process can be reused.
// Legacy workspace-writable source-index files are never read, written or removed.
const trustedIndexes = new Map<
  string,
  { cwd: string; resourceId: string; index: DocumentIndex; bytes: number }
>();
const TRUSTED_CACHE_BYTES = 8 * 1024 * 1024;
const TRUSTED_CACHE_ENTRIES = 32;
function remember(key: string, cwd: string, index: DocumentIndex): void {
  for (const chunk of index.chunks) Object.freeze(chunk);
  Object.freeze(index.chunks);
  Object.freeze(index);
  const bytes = Buffer.byteLength(JSON.stringify(index));
  if (bytes > TRUSTED_CACHE_BYTES) return;
  trustedIndexes.delete(key);
  trustedIndexes.set(key, { cwd, resourceId: index.resourceId, index, bytes });
  let total = [...trustedIndexes.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (trustedIndexes.size > TRUSTED_CACHE_ENTRIES || total > TRUSTED_CACHE_BYTES) {
    const oldest = trustedIndexes.keys().next().value!;
    total -= trustedIndexes.get(oldest)!.bytes;
    trustedIndexes.delete(oldest);
  }
}

export function uploadedDocumentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function chunkId(
  index: Pick<DocumentIndex, "resourceId" | "sourceHash">,
  chunk: Pick<DocumentChunk, "partIndex" | "start" | "end">,
): string {
  return `c_${createHash("sha256")
    .update(
      JSON.stringify([index.resourceId, index.sourceHash, chunk.partIndex, chunk.start, chunk.end]),
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function buildIndex(resourceId: string, bytes: Uint8Array, parsed: ParsedDocument): DocumentIndex {
  const index: DocumentIndex = {
    version: DOCUMENT_PARSER_VERSION,
    resourceId,
    sourceHash: uploadedDocumentHash(bytes),
    inputBytes: bytes.byteLength,
    format: parsed.format,
    truncated: parsed.truncated,
    chunks: [],
  };
  for (const [partIndex, part] of parsed.parts.entries()) {
    for (let start = 0; start < part.text.length; ) {
      if (index.chunks.length >= MAX_DOCUMENT_CHUNKS) {
        index.truncated = true;
        return index;
      }
      let end = Math.min(start + CHUNK_SIZE, part.text.length);
      // Preserve Unicode surrogate pairs in both the end and overlap boundary.
      if (end < part.text.length && /[\uDC00-\uDFFF]/.test(part.text[end])) end--;
      const chunk = {
        id: "",
        part: part.label,
        partIndex,
        start,
        end,
        text: part.text.slice(start, end),
      };
      chunk.id = chunkId(index, chunk);
      index.chunks.push(chunk);
      if (end === part.text.length) break;
      start = end - CHUNK_OVERLAP;
      if (/[\uDC00-\uDFFF]/.test(part.text[start])) start++;
    }
  }
  return index;
}

/** Bounded process-local derived bytes; every read still needs the original resource. */
export async function loadUploadedDocumentIndex(
  cwd: string,
  resourceId: string,
  bytes: Uint8Array,
  options: {
    signal?: AbortSignal;
    assertCurrent: () => void;
    resolveExecutable?: (signal?: AbortSignal) => Promise<string>;
  },
): Promise<DocumentIndex> {
  options.signal?.throwIfAborted();
  options.assertCurrent();
  const workspace = realpathSync(resolve(cwd));
  const key = JSON.stringify([
    workspace,
    resourceId,
    uploadedDocumentHash(bytes),
    DOCUMENT_PARSER_VERSION,
  ]);
  const cached = trustedIndexes.get(key);
  if (cached) {
    options.assertCurrent();
    trustedIndexes.delete(key);
    trustedIndexes.set(key, cached);
    return cached.index;
  }
  const parsed = await parseDocumentIsolated(bytes, resourceId, {
    signal: options.signal,
    resolveExecutable: options.resolveExecutable,
  });
  options.signal?.throwIfAborted();
  options.assertCurrent();
  const index = buildIndex(resourceId, bytes, parsed);
  options.assertCurrent();
  remember(key, workspace, index);
  return index;
}

/** Invalidate only this process's cache, without touching legacy or unknown disk files. */
export function invalidateUploadedDocumentIndex(cwd: string, resourceId: string): void {
  const workspace = realpathSync(resolve(cwd));
  for (const [key, value] of trustedIndexes)
    if (value.cwd === workspace && value.resourceId === resourceId) trustedIndexes.delete(key);
}

export function documentIndexText(index: DocumentIndex): string {
  const parts = new Map<number, { label: string; text: string; end: number }>();
  for (const chunk of index.chunks) {
    const part = parts.get(chunk.partIndex) ?? { label: chunk.part, text: "", end: 0 };
    part.text += chunk.text.slice(Math.max(0, part.end - chunk.start));
    part.end = chunk.end;
    parts.set(chunk.partIndex, part);
  }
  return [...parts.values()]
    .map((part) => (index.format === "text" ? part.text : `## ${part.label}\n${part.text}`))
    .join("\n\n");
}

function terms(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const result = new Set<string>();
  for (const word of normalized.match(/[\p{L}\p{N}_]+/gu) ?? [])
    if (word.length <= 64) result.add(word);
  for (const word of normalized.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
  ) ?? []) {
    const chars = Array.from(word);
    for (let i = 0; i < chars.length - 1; i++) result.add(chars[i] + chars[i + 1]);
    if (chars.length === 1) result.add(word);
  }
  return [...result];
}

/** Local lexical postings, with CJK bigrams; no model or embedding requests. */
export function searchDocumentIndex(index: DocumentIndex, query: string, limit: number) {
  const requested = terms(query).slice(0, 64);
  const postings = new Map<string, number[]>();
  index.chunks.forEach((chunk, number) => {
    for (const term of terms(chunk.text)) {
      const list = postings.get(term) ?? [];
      list.push(number);
      postings.set(term, list);
    }
  });
  const scores = new Map<number, number>();
  for (const term of requested) {
    const matches = postings.get(term) ?? [];
    const weight = 1 + Math.log(1 + index.chunks.length / (1 + matches.length));
    for (const number of matches) scores.set(number, (scores.get(number) ?? 0) + weight);
  }
  const ranked = [...scores]
    .map(([number, score]) => ({ number, score }))
    .sort((a, b) => b.score - a.score || a.number - b.number);
  return {
    format: index.format,
    parserVersion: index.version,
    sourceHash: index.sourceHash,
    resourceId: index.resourceId,
    inputBytes: index.inputBytes,
    extractionTruncated: index.truncated,
    totalMatches: ranked.length,
    hasMore: ranked.length > limit,
    matches: ranked
      .slice(0, limit)
      .map(({ number, score }) => ({ ...index.chunks[number], score })),
  };
}
