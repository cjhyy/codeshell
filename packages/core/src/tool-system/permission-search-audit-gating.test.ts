import { describe, expect, test } from "bun:test";
import { HookRegistry } from "../hooks/registry.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier, classifyBashCommand } from "./permission.js";
import { ToolRegistry } from "./registry.js";

const nonReadCommands = [
  "rg --pre processor needle README.md",
  "rg --pre=processor needle README.md",
  "rg '--pre=processor' needle README.md",
  "rg --hostname-bin=processor needle README.md",
  "rg needle *",
  "npm audit --registry {https://registry.npmjs.org,--fix}",
  "ls | rg --pre=processor needle",
  "npm audit fix",
  "npm audit fix --force",
  "npm audit --fix",
  "npm audit --fix=true",
  "npm audit -- fix",
  "pnpm audit --fix",
  "pnpm audit --fix=true",
  "yarn audit --fix",
  "yarn audit --fix=true",
];

describe("Bash search and audit argument gating", () => {
  test.each(nonReadCommands)("requires approval for %s", (command) => {
    expect(classifyBashCommand(command)).not.toBe("safe-read");
    expect(new PermissionClassifier([], "default").classify("Bash", { command })).not.toBe("allow");
  });

  test.each([
    "rg needle README.md",
    "rg -nS --glob '*.ts' needle src",
    "rg --files --hidden",
    "rg -A3 -B 2 needle README.md",
    "rg --regexp=--pre README.md",
    "rg -- '--pre=processor' README.md",
    "rg -- needle *",
    "rg 'needle{one,two}' README.md",
    "rg needle \\*",
    "rg -e 'one|two' README.md",
    "ls | rg needle",
    "grep -nE 'one|two' README.md",
    "npm audit",
    "npm audit --json",
    "npm audit --audit-level=high",
    "npm audit --omit dev",
    "pnpm audit --json",
    "yarn audit --json",
    "npm ls --depth=0 --json",
  ])("preserves a read-only invocation: %s", (command) => {
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect(new PermissionClassifier([], "default").classify("Bash", { command })).toBe("allow");
  });

  test.each(["rg --unrecognized needle README.md", "npm audit --unrecognized"])(
    "conservatively gates an unrecognized option: %s",
    (command) => {
      expect(classifyBashCommand(command)).not.toBe("safe-read");
    },
  );

  test.each(nonReadCommands)("Plan mode never calls the handler for %s", async (command) => {
    let handlerCalls = 0;
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(
      {
        name: "Bash",
        description: "fake Bash: no process is started",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        source: "builtin",
        permissionDefault: "allow",
      },
      async () => {
        handlerCalls++;
        return "ran";
      },
    );
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([], "bypassPermissions"),
      new HookRegistry(),
    );
    executor.setContext({ planMode: true } as never);
    const result = await executor.executeSingle({ id: "c1", toolName: "Bash", args: { command } });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/read-only/);
    expect(handlerCalls).toBe(0);
  });
});
