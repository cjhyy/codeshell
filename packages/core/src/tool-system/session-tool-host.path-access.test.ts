import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./context.js";
import { ToolRegistry } from "./registry.js";
import { createSessionToolHost } from "./session-tool-host.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(
  options: {
    pathAccess?: ToolContext["pathAccess"];
    overrideAccess?: ToolContext["pathAccess"];
    planMode?: boolean;
    denyRead?: boolean;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "cs-host-path-access-"));
  dirs.push(cwd);
  if (options.denyRead) {
    mkdirSync(join(cwd, ".code-shell"));
    writeFileSync(
      join(cwd, ".code-shell", "settings.json"),
      JSON.stringify({ permissions: { rules: [{ tool: "Read", decision: "deny" }] } }),
    );
  }
  const executed: string[] = [];
  const questions: string[] = [];
  const registry = new ToolRegistry({});
  for (const name of ["Read", "Write"] as const) {
    registry.registerTool(
      {
        name,
        description: "Record a path-authorized tool invocation.",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
        source: "builtin",
        isReadOnly: name === "Read",
        permissionDefault: "allow",
        pathPolicy: [{ arg: "file_path", operation: name === "Read" ? "read" : "write" }],
      },
      async (args) => {
        executed.push(`${name}:${args.file_path}`);
        return "executed";
      },
    );
  }
  const host = createSessionToolHost({
    businessSessionId: "host-path-access",
    cwd,
    registry,
    permissionMode: "acceptEdits",
    pathAccess: options.pathAccess,
    presetRules: [],
    projectTrusted: true,
    planMode: options.planMode ?? false,
    exposure: { mode: "allowlist", toolNames: new Set(["Read", "Write"]) },
    visibility: { cwd, hasGoal: false, host: "desktop", isSubAgent: false },
    approvalBackend: { requestApproval: async () => ({ approved: true }) },
    contextOverrides: {
      pathAccess: options.overrideAccess,
      askUser: async (question) => {
        questions.push(question);
        return "拒绝";
      },
    },
  });
  return { cwd, host, executed, questions };
}

describe("external host full path access", () => {
  test.each([
    ["Read", "outside"],
    ["Read", "sensitive"],
    ["Write", "sensitive"],
  ] as const)("authorizes %s of %s paths without asking", async (name, kind) => {
    const { cwd, host, executed, questions } = fixture({ pathAccess: "full" });
    const target = kind === "sensitive" ? join(cwd, ".env") : join(cwd, "..", "outside.txt");
    try {
      const result = await host.execute({ id: "full", name, input: { file_path: target } });
      expect(result.isError).not.toBe(true);
      expect(executed).toEqual([`${name}:${target}`]);
      expect(questions).toEqual([]);
      expect(host.toolContext.permissionMode).toBe("acceptEdits");
    } finally {
      await host.dispose();
    }
  });

  test("default access still prompts for external reads and denies sensitive writes", async () => {
    const { cwd, host, executed, questions } = fixture();
    try {
      const read = await host.execute({
        id: "read",
        name: "Read",
        input: { file_path: join(cwd, "..", "outside.txt") },
      });
      const write = await host.execute({
        id: "write",
        name: "Write",
        input: { file_path: join(cwd, ".env") },
      });
      expect(read.error).toContain("path approval denied");
      expect(write.error).toContain("writes are not permitted");
      expect(questions).toHaveLength(1);
      expect(executed).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  test("context overrides and tool arguments cannot grant full path access", async () => {
    const { cwd, host, executed } = fixture({ overrideAccess: "full" });
    try {
      const result = await host.execute({
        id: "smuggled",
        name: "Write",
        input: { file_path: join(cwd, ".env"), pathAccess: "full" },
      });
      expect(host.toolContext.pathAccess).toBe("default");
      expect(result.error).toContain("writes are not permitted");
      expect(executed).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  test("full path access preserves explicit user tool deny rules", async () => {
    const { cwd, host, executed, questions } = fixture({ pathAccess: "full", denyRead: true });
    try {
      const result = await host.execute({
        id: "denied",
        name: "Read",
        input: { file_path: join(cwd, ".env") },
      });
      expect(result.isError).toBe(true);
      expect(result.error).toContain("Permission denied");
      expect(executed).toEqual([]);
      expect(questions).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  test("full path access preserves the plan-mode write gate", async () => {
    const { cwd, host, executed, questions } = fixture({ pathAccess: "full", planMode: true });
    try {
      const result = await host.execute({
        id: "plan",
        name: "Write",
        input: { file_path: join(cwd, ".env") },
      });
      expect(result.isError).toBe(true);
      expect(result.error).toContain("Plan mode");
      expect(executed).toEqual([]);
      expect(questions).toEqual([]);
    } finally {
      await host.dispose();
    }
  });
});
