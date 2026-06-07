import { describe, expect, test } from "bun:test";
import { resolveExternalAgentConfig } from "./config.js";
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

  test("passes through configured trusted workspaces (Rooms permission source)", () => {
    const settings: ExternalAgentsSettings = {
      claudeCode: {
        command: "claude",
        trustedWorkspaces: [cwd],
      },
    };
    const cfg = resolveExternalAgentConfig(settings);
    expect(cfg.claudeCode.trustedWorkspaces).toEqual([cwd]);
  });
});
