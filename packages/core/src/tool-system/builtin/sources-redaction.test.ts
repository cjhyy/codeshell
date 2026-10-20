import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../context.js";
import { readSourceTool } from "./sources.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cs-sources-redaction-"));
  const uploads = join(cwd, ".code-shell", "uploads");
  mkdirSync(uploads, { recursive: true });
  writeFileSync(join(uploads, "notes.txt"), "Header, password: fixture-value");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function body(output: string): string {
  const match = /<untrusted_input>\n([\s\S]*)\n<\/untrusted_input>/.exec(output);
  if (!match) throw new Error(`unexpected ReadSource output: ${output}`);
  return match[1]!;
}

test("single-file query results are redacted without breaking their JSON", async () => {
  const output = await readSourceTool(
    { source: "project-uploads", scope: "uploads", resource: "notes.txt", query: "Header" },
    { cwd } as unknown as ToolContext,
  );
  const text = body(output);
  expect(text).not.toContain("fixture-value");
  const parsed = JSON.parse(text);
  expect(parsed.matches).toHaveLength(1);
  expect(parsed.matches[0].text).toContain("Header, password: [REDACTED]");

  const chunkOutput = await readSourceTool(
    {
      source: "project-uploads",
      scope: "uploads",
      resource: "notes.txt",
      chunk: parsed.matches[0].id,
    },
    { cwd } as unknown as ToolContext,
  );
  const chunk = JSON.parse(body(chunkOutput));
  expect(JSON.stringify(chunk)).not.toContain("fixture-value");
}, 30_000);
