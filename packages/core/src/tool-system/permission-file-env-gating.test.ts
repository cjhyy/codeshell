import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRegistry } from "../hooks/registry.js";
import { bashTool, bashToolDef } from "./builtin/bash.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier, classifyBashCommand } from "./permission.js";
import { ToolRegistry } from "./registry.js";

const gated = [
  "printenv",
  "printenv SECRET",
  "printenv 'SECRET'",
  'printenv "SECRET"',
  "printenv SE''CRET",
  "printenv S\\ECRET",
  "printenv --null",
  "printenv -0",
  "printenv -- SECRET",
  "printenv $NAME",
  "printenv-helper",
  "file -C -m review.magic",
  "file --compile -m review.magic",
  "file '-C' -m review.magic",
  "file -\\C -m review.magic",
  "file --com''pile -m review.magic",
  "file -bC -m review.magic",
  "file -m -- *C",
  "file -m '--' *C",
  "file --magic-file -- *C",
  "file -F -- *C -m review.magic",
  "file --separator -- *C -m review.magic",
  "file -m --magic-file *C",
  "file --unknown README",
  "file $FLAGS README",
  "file *",
];
const reading = [
  "file README.md",
  "file -b README.md",
  "file -bi README.md",
  "file -I README.md",
  "file --mime-type image.png",
  "file -L --brief image.png",
  "file --extension image.png",
  "file -m review.magic README",
  "file --magic-file=review.magic README",
  "file -F ':' README",
  "file -f file-list",
  "file -- --compile",
  "file -- *",
];

test.each(reading)("preserves read-only file arguments: %s", (command) => {
  expect(classifyBashCommand(command)).toBe("safe-read");
});
for (const mode of ["default", "plan"] as const) {
  test.each(gated)(
    `${mode} gates environment disclosure and file compilation: %s`,
    async (command) => {
      let calls = 0;
      let approvals = 0;
      const registry = new ToolRegistry({ builtinTools: [] });
      registry.registerTool(
        { ...bashToolDef, source: "builtin", permissionDefault: "ask" },
        async () => {
          calls++;
          return "unexpected execution";
        },
      );
      const classifier = new PermissionClassifier([], mode, {
        requestApproval: async () => {
          approvals++;
          return { approved: false };
        },
      });
      const executor = new ToolExecutor(registry, classifier, new HookRegistry());
      executor.setContext({ planMode: mode === "plan" } as never);
      const result = await executor.executeSingle({
        id: "permission-probe",
        toolName: "Bash",
        args: { command },
      });
      expect(classifyBashCommand(command)).not.toBe("safe-read");
      expect(calls).toBe(0);
      expect(result.isError).toBe(true);
      expect(approvals).toBe(mode === "plan" ? 0 : 1);
    },
  );

  test(`${mode} builtin does not expose a secret or overwrite an existing magic database`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-file-env-gating-"));
    try {
      writeFileSync(join(cwd, "review.magic"), "0 string REVIEW fixture\n");
      writeFileSync(join(cwd, "review.magic.mgc"), "original data");
      // A glob must not turn this filename into file's compile option when
      // -- was consumed as -m's value rather than an option terminator.
      writeFileSync(join(cwd, "--"), "0 string REVIEW fixture\n");
      writeFileSync(join(cwd, "-C"), "");
      writeFileSync(join(cwd, "--.mgc"), "original magic data");
      const registry = new ToolRegistry({ builtinTools: [] });
      registry.registerTool(
        { ...bashToolDef, source: "builtin", permissionDefault: "ask" },
        bashTool,
      );
      const executor = new ToolExecutor(
        registry,
        new PermissionClassifier([], mode, {
          requestApproval: async () => ({ approved: false }),
        }),
        new HookRegistry(),
      );
      executor.setContext({
        cwd,
        planMode: mode === "plan",
        shellEnv: { REVIEW_SECRET: "synthetic-private-value" },
      } as never);
      for (const command of [
        "printenv 'REVIEW_SECRET'",
        "file -C -m review.magic",
        "file -m -- *C",
        "file -F -- *C -m review.magic",
      ]) {
        const result = await executor.executeSingle({
          id: "builtin-probe",
          toolName: "Bash",
          args: { command },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
      }
      expect(readFileSync(join(cwd, "review.magic.mgc"), "utf8")).toBe("original data");
      expect(readFileSync(join(cwd, "--.mgc"), "utf8")).toBe("original magic data");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
