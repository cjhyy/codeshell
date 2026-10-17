import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanInstructions, combineInstructions } from "../../../packages/core/src/prompt/instruction-scanner.js";
import { PromptComposer } from "../../../packages/core/src/prompt/composer.js";

// Owned ordinary instruction files only. The guarded runner provides an empty HOME.
// No Engine, VCS probe, model, provider, hook, network, or tool executor is invoked.
const owned = mkdtempSync(join(tmpdir(), "codeshell-prompt-round5-"));
const project = join(owned, "project");
const child = join(project, "app");
mkdirSync(child, { recursive: true });
writeFileSync(join(project, "CODESHELL.md"), "ROOT_PROJECT");
writeFileSync(join(project, "CODESHELL.local.md"), "ROOT_LOCAL");
writeFileSync(join(child, "CODESHELL.md"), "CHILD_PROJECT");
writeFileSync(join(child, "CODESHELL.local.md"), "CHILD_LOCAL");
const options = { compatFileNames: [], boundaryFinder: () => project };
afterAll(() => rmSync(owned, { recursive: true, force: true }));

test("records ancestor local preceding descendant project contrary to the source-order contract", () => {
  const source = readFileSync(new URL("../../../packages/core/src/prompt/instruction-scanner.ts", import.meta.url), "utf8");
  expect(source).toContain("managed → user → project (root→cwd) → local");
  const entries = scanInstructions(child, options);
  const actual = entries.map(({ source, depth, content }) => ({ source, depth, content }));
  const expected = ["ROOT_PROJECT", "CHILD_PROJECT", "ROOT_LOCAL", "CHILD_LOCAL"];
  console.log("PROMPT_ORDER_RECEIPT", JSON.stringify({ actual, documentedExpected: expected }));
  expect(entries.map((entry) => entry.content)).toEqual([
    "ROOT_PROJECT", "ROOT_LOCAL", "CHILD_PROJECT", "CHILD_LOCAL",
  ]);
  expect(entries.map((entry) => entry.content)).not.toEqual(expected);
  expect(entries.map((entry) => entry.source)).toEqual(["project", "local", "project", "local"]);
  const combined = combineInstructions(entries);
  expect(combined.indexOf("ROOT_LOCAL")).toBeLessThan(combined.indexOf("CHILD_PROJECT"));
  expect(combined).toContain("local override (depth 0)");
  expect(combined).toContain("project (depth 1)");
});

test("the actual PromptComposer passes the interleaved order through unchanged", () => {
  const composer = new PromptComposer({
    cwd: child,
    model: "offline-audit",
    instructionOptions: options,
    disableMemoryContext: true,
    disableCapabilityContext: true,
    disableSourcesContext: true,
  });
  const context = composer.buildUserContextMessage();
  expect(context?.role).toBe("user");
  const content = context?.content;
  expect(typeof content).toBe("string");
  const text = content as string;
  expect(text.indexOf("ROOT_PROJECT")).toBeLessThan(text.indexOf("ROOT_LOCAL"));
  expect(text.indexOf("ROOT_LOCAL")).toBeLessThan(text.indexOf("CHILD_PROJECT"));
  expect(text.indexOf("CHILD_PROJECT")).toBeLessThan(text.indexOf("CHILD_LOCAL"));
  expect(text).toContain("<system-reminder>");
  expect(text).toContain("</system-reminder>");
});
