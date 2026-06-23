import { describe, it, expect } from "bun:test";
import { driveClaudeCodeToolDef, makeDriveClaudeCodeTool } from "./drive-claude-code.js";

describe("DriveClaudeCode tool", () => {
  it("has a name and an inputSchema with prompt", () => {
    expect(driveClaudeCodeToolDef.name).toBe("DriveClaudeCode");
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.prompt).toBeDefined();
  });
  it("runs one turn and reports sessionId + finalText", async () => {
    const tool = makeDriveClaudeCodeTool(async (o) => ({ sessionId: "S7", finalText: "did it", isError: false, exitCode: 0, lines: [] }));
    const out = await tool({ prompt: "go", cwd: "/x" });
    expect(out).toContain("S7");
    expect(out).toContain("did it");
  });
});
