import { describe, expect, test } from "bun:test";
import { HookRegistry } from "../hooks/registry.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier, classifyBashCommand } from "./permission.js";
import { ToolRegistry } from "./registry.js";

const mutating = [
  "find . -delete",
  "find . '-delete'",
  "find . -de\\lete",
  "find . -de''lete",
  "find . \\-delete",
  "find . '-exec' touch marker {} +",
  'find . -ex"ec" touch marker {} +',
  "find . '-execdir' touch marker {} +",
  "find . '-ok' touch marker {} +",
  "find . '-okdir' touch marker {} +",
  "find . '-fprint' output",
  "find . -fprint0 output",
  "find . -fprintf output '%p'",
  "find . -fls output",
  "find . $ACTION",
  "find . *",
  "find -- . *",
  "find . -unrecognized",
];
const reading = [
  "find .",
  "find . src -type f -name '*.ts' -print",
  "find -L . -maxdepth 2 -type f",
  "find -P -f src -f tests -iname '*.ts'",
  "find . \\( -name '*.ts' -o -name '*.js' \\) -print0",
  "find . -path './node_modules' -prune -o -type f -print",
  "find . -name '-delete'",
  "find . -name '-exec'",
  "find . -newermt '2026-01-01' -size +10k",
  "find . -printf '%p\\n'",
];

describe("find command permission boundary", () => {
  test.each(mutating)("gates normalized actions and dynamic arguments: %s", (command) => {
    expect(classifyBashCommand(command)).not.toBe("safe-read");
    expect(new PermissionClassifier([], "default").classify("Bash", { command })).not.toBe("allow");
  });

  test.each(reading)("preserves read-only predicates and literal arguments: %s", (command) => {
    expect(classifyBashCommand(command)).toBe("safe-read");
  });

  for (const mode of ["default", "plan"] as const) {
    test.each(mutating)(`${mode} executor does not invoke find handler: %s`, async (command) => {
      let calls = 0;
      let approvals = 0;
      const registry = new ToolRegistry({ builtinTools: [] });
      registry.registerTool(
        {
          name: "Bash",
          description: "Inert find permission probe; no process is created",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
          source: "builtin",
          permissionDefault: "ask",
        },
        async () => {
          calls++;
          return "unexpected execution";
        },
      );
      const executor = new ToolExecutor(
        registry,
        new PermissionClassifier([], mode, {
          requestApproval: async () => {
            approvals++;
            return { approved: false };
          },
        }),
        new HookRegistry(),
      );
      executor.setContext({ planMode: mode === "plan" } as never);
      const result = await executor.executeSingle({
        id: "find-probe",
        toolName: "Bash",
        args: { command },
      });
      expect(calls).toBe(0);
      expect(result.isError).toBe(true);
      expect(approvals).toBe(mode === "plan" ? 0 : 1);
    });
  }
});
