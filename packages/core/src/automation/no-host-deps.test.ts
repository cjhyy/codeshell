import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Forbidden host-coupling import substrings. The automation module must load
// in a headless server with no Electron/Ink present.
const FORBIDDEN = ["electron", "ink", "react", "@cjhyy/code-shell-tui"];

function sourceFiles(): string[] {
  return readdirSync(here)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(here, f));
}

describe("automation module is host-agnostic", () => {
  test("no source file imports Electron/Ink/React", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf-8");
      // Only inspect import/require lines.
      const importLines = src
        .split("\n")
        .filter((l) => /\b(import|require)\b/.test(l));
      for (const line of importLines) {
        for (const bad of FORBIDDEN) {
          if (line.includes(`"${bad}`) || line.includes(`'${bad}`) || line.includes(`/${bad}`)) {
            offenders.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
