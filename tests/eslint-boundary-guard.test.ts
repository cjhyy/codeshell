import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();

function lintStdin(filename: string, source: string) {
  return spawnSync("bunx", ["eslint", "--stdin", "--stdin-filename", filename], {
    cwd: repoRoot,
    encoding: "utf8",
    input: source,
  });
}

describe("ESLint CodeShell package boundary guards", () => {
  it("rejects host leaks and capability imports outside the extension contract", () => {
    const probes = [
      lintStdin(
        "packages/core/src/__lint_boundary_probe__.ts",
        [
          'import "../../tui/src/index";',
          "export async function loadTui() {",
          '  return import("@cjhyy/code-shell-tui");',
          "}",
          "",
        ].join("\n"),
      ),
      lintStdin(
        "packages/desktop/src/renderer/__lint_boundary_probe__.tsx",
        [
          'import { PluginLifecycleRuntime } from "@cjhyy/code-shell-core/plugin-runtime";',
          "export const runtime = PluginLifecycleRuntime;",
          "export async function loadCore() {",
          '  return import("@cjhyy/code-shell-core/browser/not-reviewed");',
          "}",
          "",
        ].join("\n"),
      ),
      lintStdin(
        "packages/coding/src/__lint_boundary_probe__.ts",
        [
          'import { Engine } from "@cjhyy/code-shell-core";',
          "export const marker = Engine;",
          "",
        ].join("\n"),
      ),
      lintStdin(
        "packages/arena/src/__lint_boundary_probe__.ts",
        ['export { WorkerBridgeCore } from "@cjhyy/code-shell-server";', ""].join("\n"),
      ),
    ];
    const output = probes.map((result) => `${result.stdout}\n${result.stderr}`).join("\n");

    for (const result of probes) expect(result.status).not.toBe(0);
    expect(output).toContain("core must not import tui");
    expect(output).toContain("renderer must not import codeshell packages at runtime");
    expect(output).toContain("renderer may runtime-import only reviewed core browser entry points");
    expect(output).toContain(
      "capability packages must import core through @cjhyy/code-shell-core/extension",
    );
    expect(output).toContain(
      "capability packages must not depend on another CodeShell product or host package",
    );
  });

  it("allows the exact reviewed browser-safe core entry in the renderer", () => {
    const result = lintStdin(
      "packages/desktop/src/renderer/__lint_boundary_browser_safe_probe__.tsx",
      [
        'import { PluginLifecycleRuntime } from "@cjhyy/code-shell-core/browser/plugin-runtime";',
        'import type { StreamEvent } from "@cjhyy/code-shell-core";',
        "export const runtime = new PluginLifecycleRuntime<unknown, Record<string, unknown>>();",
        "export type RendererStreamEvent = StreamEvent;",
        "",
      ].join("\n"),
    );

    expect(`${result.stdout}\n${result.stderr}`).toBe("\n");
    expect(result.status).toBe(0);
  });
});
