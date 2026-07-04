import { describe, expect, test } from "bun:test";
import { bashToolDef } from "../tool-system/builtin/bash.js";
import { powershellToolDef } from "../tool-system/builtin/powershell.js";
import { buildPresetSystemPrompt, BUILTIN_AGENT_PRESETS } from "./index.js";

describe("shell tool selection guidance", () => {
  test("non-Windows system prompt keeps Windows-specific shell guidance out of the cacheable base", () => {
    const out = buildPresetSystemPrompt(BUILTIN_AGENT_PRESETS["terminal-coding"], {
      activeToolNames: ["Bash", "PowerShell"],
      platform: "linux",
    });
    expect(out).toContain("use Bash for ordinary shell commands");
    expect(out).not.toContain("Git Bash");
    expect(out).not.toContain("do not choose PowerShell merely because the OS is Windows");
  });

  test("Windows system prompt adds Git Bash guidance", () => {
    const out = buildPresetSystemPrompt(BUILTIN_AGENT_PRESETS["terminal-coding"], {
      activeToolNames: ["Bash", "PowerShell"],
      platform: "win32",
    });
    expect(out).toContain("On Windows, Bash uses Git Bash when it is available");
    expect(out).toContain("Do not choose PowerShell merely because the OS is Windows");
    expect(out).toContain("use Git Bash paths such as `/d/github/project`");
  });

  test("tool descriptions steer ordinary commands to Bash and reserve PowerShell for PowerShell-specific work", () => {
    expect(bashToolDef.description).toContain("Prefer Bash over PowerShell");
    expect(powershellToolDef.description).toContain("PowerShell-specific cmdlets");
    expect(powershellToolDef.description).toContain("Do NOT use for ordinary file, git, package-manager, test");
    expect(powershellToolDef.description).not.toContain("Git Bash");
  });
});
