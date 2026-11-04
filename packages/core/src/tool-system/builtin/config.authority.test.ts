import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configTool, makeConfigTool } from "./config.js";
import { classifyPath, enforcePathPolicyWithApproval } from "../path-policy.js";
import { PermissionClassifier } from "../permission.js";
import { SettingsManager } from "../../settings/manager.js";
import type { ToolContext } from "../context.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "config-authority-"));
  roots.push(cwd);
  mkdirSync(join(cwd, ".code-shell"));
  const file = join(cwd, ".code-shell/settings.json");
  writeFileSync(file, JSON.stringify({ agent: { responseLanguage: "en" } }));
  return { cwd, file, ctx: { cwd, permissionMode: "default" } as ToolContext };
}

test("approved Config writes stay scoped while ordinary file tools retain credential protection", async () => {
  const { cwd, file, ctx } = fixture();
  expect(
    await configTool({ action: "write", key: "agent.responseLanguage", value: "zh" }, ctx),
  ).toContain("Updated");
  expect(JSON.parse(readFileSync(file, "utf8")).agent.responseLanguage).toBe("zh");
  expect(classifyPath(file, { operation: "write", workspaceRoot: cwd }).decision).toBe("deny");
  expect(await enforcePathPolicyWithApproval(file, "write", ctx)).toContain(
    "blocked by path policy",
  );
  expect(await enforcePathPolicyWithApproval(file, "read", ctx)).toContain("requires approval");
  expect(JSON.parse(await configTool({ action: "read" }, ctx)).agent.responseLanguage).toBe("zh");
});

test("Config has no acceptEdits auto-approval exemption", () => {
  const permissions = new PermissionClassifier([], "acceptEdits");
  expect(
    permissions.classify("Config", {
      action: "write",
      key: "permissions.defaultMode",
      value: "auto",
    }),
  ).toBe("ask");
});

test("Config keeps plan mode and stopped runs from persisting writes", async () => {
  const { file, ctx } = fixture();
  const args = { action: "write", key: "agent.responseLanguage", value: "zh" };
  expect(await configTool(args, { ...ctx, planMode: true })).toContain("Plan mode");
  const controller = new AbortController();
  const tool = makeConfigTool({
    makeSettingsManager: (cwd, scope) => new SettingsManager(cwd, scope),
    beforeWrite: async () => controller.abort(),
  });
  expect(await tool(args, { ...ctx, signal: controller.signal })).toContain("cancelled");
  expect(JSON.parse(readFileSync(file, "utf8")).agent.responseLanguage).toBe("en");
});

test("Config cannot redirect its fixed settings target through a symlink", async () => {
  const { file, ctx } = fixture();
  const outside = join(roots[0]!, "outside.json");
  writeFileSync(outside, '{"agent":{"responseLanguage":"en"}}');
  rmSync(file);
  symlinkSync(outside, file);
  expect(
    await configTool({ action: "write", key: "agent.responseLanguage", value: "zh" }, ctx),
  ).toMatch(/^Error:/);
  expect(await configTool({ action: "read" }, ctx)).toMatch(/^Error:/);
  expect(JSON.parse(readFileSync(outside, "utf8")).agent.responseLanguage).toBe("en");
});
