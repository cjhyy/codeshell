/**
 * The `@cjhyy/code-shell-core/extension` entry is the ONLY way a capability
 * package (packages/coding) is supposed to reach core. That makes its export
 * list a security surface, not just an ergonomics choice.
 *
 * `SessionToolHost` must be the strongest tool-execution handle available
 * through it. If `ToolExecutor`, `ToolRegistry` or `PermissionClassifier` ever
 * appear here, a capability gains a *supported* path around SessionToolHost —
 * and with it around visibility, plan mode, path policy, permission, sandbox and
 * hooks. The design (§6.2, §7.1) calls ToolExecutor the single authorization
 * point; this test is what keeps that true as the export list grows.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as extension from "./index.extension.js";

const FORBIDDEN = ["ToolExecutor", "ToolRegistry", "PermissionClassifier"] as const;

describe("extension entry tool-host contract", () => {
  test("exposes the session tool host factory and its types", () => {
    expect(typeof extension.createSessionToolHost).toBe("function");
  });

  test("does not export any handle that bypasses SessionToolHost", () => {
    for (const name of FORBIDDEN) {
      expect(Object.keys(extension)).not.toContain(name);
    }
  });

  test("does not re-export the bypass classes even as types", () => {
    // A `export type { ToolExecutor }` would not show up in the runtime
    // namespace above, but it still hands callers the shape to construct or
    // accept one. Check the source text so both forms are covered.
    const source = readFileSync(new URL("./index.extension.ts", import.meta.url), "utf8");
    // Strip comments: the file explains WHY these are absent, and those
    // mentions must not trip the check.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const name of FORBIDDEN) {
      expect(code).not.toContain(name);
    }
  });
});
