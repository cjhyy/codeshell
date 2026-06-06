import { describe, expect, test } from "bun:test";
import { resolveExternalAgentConfig, resolveClaudeModeForWorkspace } from "./config.js";
import type { ExternalAgentsSettings } from "./types.js";

const cwd = "/Users/admin/Documents/个人学习/代码学习/codeshell";

describe("external agent config", () => {
  test("defaults Claude Code to safe mode with no dangerous args", () => {
    const cfg = resolveExternalAgentConfig(undefined);
    expect(cfg.claudeCode.command).toBe("claude");
    expect(cfg.claudeCode.defaultMode).toBe("safe");
    expect(cfg.claudeCode.dangerousArgs).toEqual([]);
    expect(cfg.claudeCode.trustedWorkspaces).toEqual([]);
    expect(cfg.claudeCode.autoStartInTrustedWorkspaces).toBe(false);
  });

  test("allows project default dangerous only in trusted workspace", () => {
    const settings: ExternalAgentsSettings = {
      claudeCode: {
        command: "claude",
        defaultMode: "dangerous",
        dangerousArgs: ["--dangerously-skip-permissions"],
        trustedWorkspaces: [cwd],
        autoStartInTrustedWorkspaces: true,
      },
    };
    const cfg = resolveExternalAgentConfig(settings);
    expect(resolveClaudeModeForWorkspace(cfg.claudeCode, cwd, undefined)).toEqual({
      mode: "dangerous",
      args: ["--dangerously-skip-permissions"],
      requiresHighRiskApproval: false,
      reason: "trusted_workspace_default",
    });
    expect(resolveClaudeModeForWorkspace(cfg.claudeCode, "/tmp/other", undefined)).toEqual({
      mode: "dangerous",
      args: ["--dangerously-skip-permissions"],
      requiresHighRiskApproval: true,
      reason: "dangerous_outside_trusted_workspace",
    });
  });

  test("/cc --safe overrides dangerous default", () => {
    const cfg = resolveExternalAgentConfig({
      claudeCode: {
        defaultMode: "dangerous",
        dangerousArgs: ["--dangerously-skip-permissions"],
        trustedWorkspaces: [cwd],
        autoStartInTrustedWorkspaces: true,
      },
    });
    expect(resolveClaudeModeForWorkspace(cfg.claudeCode, cwd, "safe")).toEqual({
      mode: "safe",
      args: [],
      requiresHighRiskApproval: false,
      reason: "explicit_safe",
    });
  });

  test("/cc --dangerous requests high-risk approval outside trusted workspace", () => {
    const cfg = resolveExternalAgentConfig({
      claudeCode: {
        dangerousArgs: ["--dangerously-skip-permissions"],
        trustedWorkspaces: [cwd],
      },
    });
    expect(resolveClaudeModeForWorkspace(cfg.claudeCode, "/tmp/other", "dangerous")).toEqual({
      mode: "dangerous",
      args: ["--dangerously-skip-permissions"],
      requiresHighRiskApproval: true,
      reason: "explicit_dangerous_outside_trusted_workspace",
    });
  });
});
