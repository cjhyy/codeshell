import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourceTool } from "../../../packages/core/src/tool-system/builtin/sources.ts";

test("actual local ReadSource handler returns malformed single file query JSON for a placeholder line", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codeshell-sources-json-observation-"));
  try {
    const uploads = join(cwd, ".code-shell", "uploads");
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, "plain.txt"), "Header, ordinary: fixture-value");
    writeFileSync(join(uploads, "notes.txt"), "Header, password: fixture-value");
    const read = (resource: string) => readSourceTool({
      source: "project-uploads", scope: "uploads", resource, query: "Header",
    }, { cwd } as any);
    const body = (output: string) => {
      const match = /<untrusted_input>\n([\s\S]*)\n<\/untrusted_input>/.exec(output);
      expect(match).not.toBeNull();
      return match![1];
    };
    const control = body(await read("plain.txt"));
    expect(JSON.parse(control).matches).toHaveLength(1);
    const observedOutput = await read("notes.txt");
    const observed = body(observedOutput);
    expect(observedOutput).not.toContain("Error: read failed");
    expect(observed).not.toContain("fixture-value");
    expect(() => JSON.parse(observed)).toThrow();
    console.log(JSON.stringify({ case: "actual-readsource-single-query", controlJsonValid: true, observedJsonValid: false, observedOutput }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
