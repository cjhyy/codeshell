import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TOOLS } from "./index.js";

interface ToolCoverage {
  name: string;
  testFiles: string[];
}

const builtinDirectory = dirname(fileURLToPath(import.meta.url));
const coverageTestFilename = basename(fileURLToPath(import.meta.url));
const testFiles = readdirSync(builtinDirectory)
  .filter((filename) => filename.endsWith(".test.ts") && filename !== coverageTestFilename)
  .sort();
const testSources = new Map(
  testFiles.map((filename) => [filename, readFileSync(join(builtinDirectory, filename), "utf8")]),
);

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/[^a-zA-Z\d]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function toLowerCamelCase(value: string): string {
  const words = toKebabCase(value).split("-");
  return words
    .map((word, index) => (index === 0 ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
    .join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function filenameMentionsTool(filename: string, toolName: string): boolean {
  const filenameStem = toKebabCase(filename.replace(/\.test\.ts$/, ""));
  const toolStem = toKebabCase(toolName);
  const paddedFilename = `-${filenameStem}-`;

  return (
    paddedFilename.includes(`-${toolStem}-`) ||
    paddedFilename.replaceAll("-", "").includes(toolStem.replaceAll("-", ""))
  );
}

function sourceReferencesTool(source: string, toolName: string, executorName: string): boolean {
  const toolIdentifier = toLowerCamelCase(toolName);
  const candidates = new Set(
    [
      executorName,
      `${toolIdentifier}Tool`,
      `${toolIdentifier}ToolDef`,
      `make${toolIdentifier.charAt(0).toUpperCase()}${toolIdentifier.slice(1)}Tool`,
    ].filter((name) => name.length > 0),
  );

  return [...candidates].some((candidate) =>
    new RegExp(`\\b${escapeRegExp(candidate)}\\b`).test(source),
  );
}

const coverage: ToolCoverage[] = BUILTIN_TOOLS.map((tool) => ({
  name: tool.definition.name,
  testFiles: testFiles.filter((filename) => {
    const source = testSources.get(filename) ?? "";
    return (
      filenameMentionsTool(filename, tool.definition.name) ||
      sourceReferencesTool(source, tool.definition.name, tool.execute.name)
    );
  }),
}));

function formatCoverageMatrix(rows: ToolCoverage[]): string {
  const covered = rows.filter((row) => row.testFiles.length > 0).length;
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const lines = rows.map((row, index) => {
    const branch = index === rows.length - 1 ? "└─" : "├─";
    const status = row.testFiles.length > 0 ? "✓" : "○";
    const files = row.testFiles.length > 0 ? row.testFiles.join(", ") : "(missing)";
    return `${branch} ${status} ${row.name.padEnd(nameWidth)}  ${files}`;
  });

  return [
    `Builtin tool test coverage: ${covered}/${rows.length} covered, ${rows.length - covered} missing`,
    ...lines,
  ].join("\n");
}

describe("builtin tool test coverage matrix (informational)", () => {
  test("prints the current builtin tool coverage matrix", () => {
    expect(BUILTIN_TOOLS.length).toBeGreaterThan(0);
    console.log(`\n${formatCoverageMatrix(coverage)}\n`);
  });

  for (const row of coverage) {
    const label = `${row.name}: ${row.testFiles.join(", ") || "missing"}`;
    if (row.testFiles.length > 0) {
      test(label, () => {
        expect(row.testFiles.length).toBeGreaterThan(0);
      });
    } else {
      test.skip(label, () => {});
    }
  }
});
