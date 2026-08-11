import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();

/**
 * Each probe is a full `bunx eslint` spawn (~2s: bunx resolution + loading the
 * flat config and the typescript-eslint plugin). The multi-probe test runs five
 * of them serially, so it needs well past bun's 5s default — it was timing out
 * and reporting as a boundary-guard FAILURE even though every probe produced the
 * expected violations.
 */
const LINT_PROBE_TIMEOUT_MS = 120_000;

function lintStdin(filename: string, source: string) {
  return spawnSync("bunx", ["eslint", "--stdin", "--stdin-filename", filename], {
    cwd: repoRoot,
    encoding: "utf8",
    input: source,
  });
}

describe("ESLint CodeShell package boundary guards", () => {
  it(
    "rejects host leaks and capability imports outside the extension contract",
    () => {
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
            'import { PanelAppLifecycleRuntime } from "@cjhyy/code-shell-core/panel-app-runtime";',
            'import { LINK_PROVIDERS } from "@cjhyy/code-shell-link";',
            'import { createCodingCapability } from "@cjhyy/code-shell-capability-coding";',
            "export const runtime = PanelAppLifecycleRuntime;",
            "export const leaks = [LINK_PROVIDERS, createCodingCapability];",
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
      expect(output).toContain(
        "renderer may runtime-import only reviewed core browser entry points",
      );
      expect(output).toContain(
        "capability packages must import core through @cjhyy/code-shell-core/extension",
      );
      expect(output).toContain(
        "capability packages must not depend on another CodeShell product or host package",
      );
    },
    LINT_PROBE_TIMEOUT_MS,
  );

  it(
    "allows the exact reviewed browser-safe core entry in the renderer",
    () => {
      const result = lintStdin(
        "packages/desktop/src/renderer/__lint_boundary_browser_safe_probe__.tsx",
        [
          'import { PanelAppLifecycleRuntime } from "@cjhyy/code-shell-core/browser/panel-app-runtime";',
          'import { mobile } from "@cjhyy/code-shell-web";',
          'import type { StreamEvent } from "@cjhyy/code-shell-core";',
          "export const runtime = new PanelAppLifecycleRuntime<unknown, Record<string, unknown>>();",
          "export const translations = mobile;",
          "export type RendererStreamEvent = StreamEvent;",
          "",
        ].join("\n"),
      );

      expect(`${result.stdout}\n${result.stderr}`).toBe("\n");
      expect(result.status).toBe(0);
    },
    LINT_PROBE_TIMEOUT_MS,
  );

  it(
    "enforces the TUI renderer runtime-safety rules",
    () => {
      const result = lintStdin(
        "packages/tui/src/render/__lint_runtime_probe__.ts",
        [
          'import * as fs from "node:fs";',
          'import { readFileSync as readDirect } from "node:fs";',
          'const fakeFs = { readFileSync() { return "safe"; } };',
          "const env = process.env.RUNTIME_PROBE;",
          "const cwd = process.cwd();",
          'readDirect("probe", "utf8");',
          'fs.readFileSync("probe", "utf8");',
          'void import("./probe.js");',
          "process.exit(1);",
          "export function callUnrelatedMethod() { return fakeFs.readFileSync(); }",
          "export { env, cwd };",
          "",
        ].join("\n"),
      );
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).not.toBe(0);
      expect(output).toContain("avoid synchronous filesystem I/O");
      expect(output.split("avoid synchronous filesystem I/O")).toHaveLength(3);
      expect(output).toContain("read process.env inside a function");
      expect(output).toContain("use the injected workspace cwd");
      expect(output).toContain("move dynamic import inside a function");
      expect(output).toContain("set exitCode or use the host exit seam");
      expect(output).toContain("move module initialization behind a seam");
    },
    LINT_PROBE_TIMEOUT_MS,
  );
});
