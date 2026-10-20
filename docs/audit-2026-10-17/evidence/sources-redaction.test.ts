import { expect, test } from "bun:test";
import {
  searchDocumentIndex,
  searchDocumentIndexes,
} from "../../../packages/core/src/sources/documents/index-store.ts";
import { scrubSecrets, scrubSecretValue } from "../../../packages/core/src/utils/secret-scrubber.ts";
import type { DocumentIndex } from "../../../packages/core/src/sources/documents/types.ts";

const placeholder = "Header, password: fixture-value";
const index: DocumentIndex = {
  version: "1", resourceId: "notes.txt", sourceHash: "a".repeat(64),
  inputBytes: Buffer.byteLength(placeholder), format: "text", truncated: false,
  chunks: [{ id: "c_" + "a".repeat(24), part: "text", partIndex: 0, start: 0, end: placeholder.length, text: placeholder }],
};

test("observation: the single file query redaction sequence breaks result JSON", () => {
  // Same data operations as adapters/{local-files,collection}.ts -> sources.ts.
  // This is a fabricated local placeholder, not a credential or external input.
  const before = JSON.stringify(searchDocumentIndex(index, "Header", 5));
  const after = scrubSecrets(before);
  expect(JSON.parse(before).matches).toHaveLength(1);
  expect(() => JSON.parse(after)).toThrow();
  expect(after).not.toContain("fixture-value");
  console.log(JSON.stringify({ case: "single-file-query-json", before, after, validJsonAfter: false }));
});

test("control: corpus redaction preserves JSON by scrubbing values before serialization", () => {
  const after = JSON.stringify(scrubSecretValue(searchDocumentIndexes([index], "Header", 5)));
  expect(JSON.parse(after).matches).toHaveLength(1);
  expect(after).not.toContain("fixture-value");
  console.log(JSON.stringify({ case: "cross-file-query-json-control", after, validJsonAfter: true }));
});
