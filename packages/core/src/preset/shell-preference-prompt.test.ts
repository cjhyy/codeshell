import { describe, expect, test } from "bun:test";
import { bashToolDef } from "../tool-system/builtin/bash.js";
import { powershellToolDef } from "../tool-system/builtin/powershell.js";
import { buildPresetSystemPrompt, BUILTIN_AGENT_PRESETS } from "./index.js";

describe("shell tool selection guidance", () => {
  test("system prompt tells the model to prefer Bash/Git Bash for ordinary shell work", () => {
    const out = buildPresetSystemPrompt(BUILTIN_AGENT_PRESETS["terminal-coding"], ["Bash", "PowerShell"]);
    expect(out).toContain("On Windows, Bash uses Git Bash when it is available");
    expect(out).toContain("do not choose PowerShell merely because the OS is Windows");
  });

  test("tool descriptions steer ordinary commands to Bash and reserve PowerShell for PowerShell-specific work", () => {
    expect(bashToolDef.description).toContain("Git Bash");
    expect(bashToolDef.description).toContain("prefer Bash over PowerShell");
    expect(powershellToolDef.description).toContain("PowerShell-specific cmdlets");
    expect(powershellToolDef.description).toContain("prefer Bash");
  });
});
