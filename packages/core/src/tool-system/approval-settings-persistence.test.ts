import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractiveApprovalBackend } from "./permission.js";
import {
  enforcePathPolicyWithApproval,
  _resetSessionPathGrants,
  classifyPath,
} from "./path-policy.js";
import type { ToolContext } from "./context.js";

for (const kind of ["rule", "path"] as const) {
  for (const format of ["corrupt", "yaml"] as const) {
    test(`${kind} grant preserves ${format} settings`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "approval-settings-"));
      const config = join(cwd, ".code-shell");
      mkdirSync(config);
      const file = join(config, format === "yaml" ? "settings.local.yaml" : "settings.local.json");
      const raw = format === "yaml" ? "customFixtureKey: preserved\n" : "{broken config";
      writeFileSync(file, raw);
      try {
        if (kind === "rule") {
          const backend = new InteractiveApprovalBackend();
          backend.setSessionContext("fixture", { cwd, onProjectRules() {} });
          backend.setPromptFn(async () => ({ approved: true, scope: "project" }));
          expect(
            (
              await backend.requestApproval({
                sessionId: "fixture",
                toolName: "Bash",
                args: { command: "curl https://fixture.invalid" },
                description: "",
                riskLevel: "medium",
              })
            ).approved,
          ).toBe(true);
        } else {
          _resetSessionPathGrants();
          const context = {
            cwd,
            sessionId: "fixture",
            askUser: async () => "本目录本项目允许",
          } as unknown as ToolContext;
          expect(
            await enforcePathPolicyWithApproval(
              join(tmpdir(), "fixture-outside.txt"),
              "read",
              context,
            ),
          ).toBeNull();
        }
        if (format === "corrupt") expect(readFileSync(file, "utf8")).toBe(raw);
        else {
          const saved = JSON.parse(readFileSync(join(config, "settings.local.json"), "utf8"));
          expect(saved.customFixtureKey).toBe("preserved");
          expect(
            kind === "rule" ? saved.permissions.rules.length : saved.pathApprovals.length,
          ).toBe(1);
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
}

test("project-local settings require approval to read", () => {
  const cwd = mkdtempSync(join(tmpdir(), "project-secret-path-"));
  try {
    mkdirSync(join(cwd, ".code-shell"));
    const file = join(cwd, ".code-shell", "settings.local.json");
    writeFileSync(file, "{}");
    expect(classifyPath(file, {operation: "read", cwd}).decision).toBe("ask");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
