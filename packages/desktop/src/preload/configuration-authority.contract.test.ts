import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("renderer configuration preload contract", () => {
  test("retires cwd configuration signatures in favor of stable identity targets", () => {
    const preload = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const types = readFileSync(join(import.meta.dir, "types.d.ts"), "utf8");
    const shared = readFileSync(
      join(import.meta.dir, "..", "shared", "renderer-configuration.ts"),
      "utf8",
    );

    expect(types).toContain("export type { RendererConfigurationTarget }");
    expect(shared).toContain("export type RendererConfigurationTarget =");
    expect(shared).toContain("| { projectId: string }");
    expect(shared).toContain("| { sessionId: string }");
    expect(shared).toContain("| { noRepo: true }");

    const retired = [
      "listSkills(cwd:",
      "listPlugins(cwd:",
      "listPluginCommands(cwd:",
      "expandPluginCommand(\n    cwd:",
      "listCapabilities(cwd:",
      "setCapabilityEnabled(\n    cwd:",
      "setCapabilityOverride(cwd:",
      "listProfiles(cwd?:",
      "activateProfile(cwd:",
      "deactivateProfile(cwd:",
      "previewProfileRequirements(\n    name: string,\n    cwd:",
      "installProfileRequirements(name: string, cwd:",
      "listAgents(cwd:",
      "readSkillBody(filePath:",
      "checkSkillUpdate(filePath:",
      "updateSkill(filePath:",
      "readAgentBody(filePath:",
    ];
    for (const signature of retired) expect(types).not.toContain(signature);

    expect(preload).not.toContain('ipcRenderer.invoke("skills:list", cwd');
    expect(preload).not.toContain('ipcRenderer.invoke("plugins:list", cwd');
    expect(preload).not.toContain('ipcRenderer.invoke("plugin-commands:list", cwd');
    expect(preload).not.toContain('ipcRenderer.invoke("profiles:list", cwd');
    expect(preload).not.toContain('ipcRenderer.invoke("capabilities:list", cwd');
    expect(preload).not.toContain('ipcRenderer.invoke("agents:list", cwd');
    expect(preload).not.toContain('"settings:getProject"');
    expect(preload).not.toContain('"settings:setProject"');
    expect(types).not.toContain("getProjectSettings(");
    expect(types).not.toContain("updateProjectSettings(");
    expect(preload).toContain('"settings:getConfiguration"');
    expect(preload).toContain('"settings:setConfiguration"');
  });
});
