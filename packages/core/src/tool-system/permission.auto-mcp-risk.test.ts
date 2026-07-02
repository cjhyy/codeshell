import { describe, it, expect } from "bun:test";
import { PermissionClassifier, AutoApprovalBackend } from "./permission.js";
import type { ApprovalBackend } from "./permission.js";
import type { ApprovalRequest, ApprovalResult } from "../types.js";

/**
 * #2 regression: in `auto` mode, AutoApprovalBackend auto-approves any request
 * whose riskLevel is "low" BEFORE consulting the delegate. assessRisk used to
 * label every non-Bash/non-Write/Edit tool — including all MCP tools — "low",
 * so a side-effecting MCP tool (delete a record, send a message, deploy) ran
 * with no prompt and no delegate consultation. MCP / unknown tools must be at
 * least "medium" so they fail closed (no delegate) or get delegated (UI).
 */
describe("auto mode does not blind-approve MCP / unknown tools", () => {
  it("fails closed for an MCP tool when no interactive delegate is available", async () => {
    const classifier = new PermissionClassifier([], "auto", new AutoApprovalBackend());
    const approved = await classifier.handleAsk("mcp__some-server__delete_record", {
      id: "row-1",
    });
    expect(approved).toBe(false);
  });

  it("delegates an MCP tool to the interactive backend instead of auto-approving", async () => {
    const seen: string[] = [];
    const delegate: ApprovalBackend = {
      async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
        seen.push(req.toolName);
        return { approved: false, reason: "denied by test delegate" };
      },
    };
    const classifier = new PermissionClassifier([], "auto", new AutoApprovalBackend(delegate));
    const approved = await classifier.handleAsk("mcp__deploy__ship_to_prod", {});
    expect(approved).toBe(false);
    expect(seen).toContain("mcp__deploy__ship_to_prod");
  });

  it("still auto-approves genuinely read-only built-in tools (Read/Grep/...)", async () => {
    const classifier = new PermissionClassifier([], "auto", new AutoApprovalBackend());
    for (const tool of ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch"]) {
      const approved = await classifier.handleAsk(tool, { path: "x" });
      expect(approved).toBe(true);
    }
  });
});
