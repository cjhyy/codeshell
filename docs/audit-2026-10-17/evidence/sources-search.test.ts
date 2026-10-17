import { expect, test } from "bun:test";
import {
  documentIndexText,
  searchDocumentIndex,
  searchDocumentIndexes,
} from "../../../packages/core/src/sources/documents/index-store.ts";
import type { DocumentIndex } from "../../../packages/core/src/sources/documents/types.ts";

function index(resourceId: string, text: string): DocumentIndex {
  return {
    version: "1", resourceId, sourceHash: "a".repeat(64),
    inputBytes: Buffer.byteLength(text), format: "text", truncated: false,
    chunks: [{ id: "c_" + "a".repeat(24), part: "text", partIndex: 0, start: 0, end: text.length, text }],
  };
}

test("candidate observation: Latin and numeric keywords adjacent to Han do not match", () => {
  const cases = [
    { text: "使用Redis保存会话", query: "Redis" },
    { text: "2026年预算", query: "2026" },
    { text: "OAuth2登录流程", query: "OAuth2" },
  ];
  for (const { text, query } of cases) {
    const compact = searchDocumentIndex(index("compact.txt", text), query, 5);
    const spaced = searchDocumentIndex(index("spaced.txt", text.replace(query, ` ${query} `)), query, 5);
    expect(compact.matches).toHaveLength(0);
    expect(spaced.matches).toHaveLength(1);
    console.log(JSON.stringify({ case: "mixed-script-keyword", text, query, actualCompactMatches: compact.totalMatches, spacedControlMatches: spaced.totalMatches }));
  }
});

test("the mixed script observation propagates to corpus lexical ranking", () => {
  const result = searchDocumentIndexes([
    index("compact.txt", "使用Redis保存会话"),
    index("spaced.txt", "使用 Redis 保存会话"),
  ], "Redis", 20);
  expect(result.matches.map((match) => match.resourceId)).toEqual(["spaced.txt"]);
  expect(result.totalMatches).toBe(1);
  console.log(JSON.stringify({ case: "mixed-script-corpus", actualResources: result.matches.map((match) => match.resourceId) }));
});

test("overlapping chunks reconstruct an unchanged Unicode original without duplicated overlap", () => {
  const text = "界".repeat(2_799) + "😀" + " budget milestone ".repeat(150);
  let end = 3_000;
  if (/[\uDC00-\uDFFF]/.test(text[end])) end--;
  let next = end - 200;
  if (/[\uDC00-\uDFFF]/.test(text[next])) next++;
  const value = index("overlap.txt", text);
  value.chunks = [
    { ...value.chunks[0], end, text: text.slice(0, end) },
    { ...value.chunks[0], id: "c_" + "b".repeat(24), start: next, end: text.length, text: text.slice(next) },
  ];
  expect(documentIndexText(value)).toBe(text);
  expect(searchDocumentIndex(value, "milestone", 1).hasMore).toBe(true);
});
