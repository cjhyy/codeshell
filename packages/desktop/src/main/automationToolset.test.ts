import { describe, it, expect } from "bun:test";
import { BUILTIN_TOOLS } from "@cjhyy/code-shell-core";
import {
  automationBuiltinTools,
  AUTOMATION_DISABLED_TOOLS,
} from "./automationToolset";
describe("automationBuiltinTools", () => {
  it("excludes the cron tools", () => {
    const names = automationBuiltinTools();
    expect(names).not.toContain("CronCreate");
    expect(names).not.toContain("CronDelete");
    expect(names).not.toContain("CronList");
  });
  it("excludes AskUserQuestion (no human present in an unattended run)", () => {
    expect(automationBuiltinTools()).not.toContain("AskUserQuestion");
  });
  it("excludes MCP tools so unattended runs cannot block on external MCP startup", () => {
    const names = automationBuiltinTools();
    expect(names).not.toContain("MCPTool");
    expect(names).not.toContain("ListMcpResources");
    expect(names).not.toContain("ReadMcpResource");
  });
  it("keeps a normal read tool like Read", () => {
    expect(automationBuiltinTools()).toContain("Read");
  });
  // Guards against silent drift: disabledBuiltinTools just deletes names, so if
  // a cron tool is renamed in core the exclusion would silently no-op. Anchor
  // the disabled list to the REAL builtin registry so a rename fails this test.
  it("AUTOMATION_DISABLED_TOOLS are all real builtin tool names", () => {
    const realNames = new Set(BUILTIN_TOOLS.map((t) => t.definition.name));
    for (const name of AUTOMATION_DISABLED_TOOLS) {
      expect(realNames.has(name)).toBe(true);
    }
  });
});
