import { describe, expect, test } from "bun:test";
import { powershellTool } from "./powershell.js";
import type { ToolContext } from "../context.js";
import type { SandboxBackend } from "../sandbox/index.js";

function ctx(extra: Partial<ToolContext>): ToolContext {
  return { cwd: process.cwd(), ...extra } as ToolContext;
}

describe("PowerShell sandbox status", () => {
  test("reports unisolated even when the run has an active sandbox backend", async () => {
    const fakeBackend: SandboxBackend = {
      name: "seatbelt",
      network: "deny",
      wrap() {
        throw new Error(
          "PowerShell should not be routed through the sandbox wrapper in this patch",
        );
      },
    };

    const out = await powershellTool(
      { command: "Write-Output sandbox-status", timeout: 5_000 },
      ctx({ sandbox: fakeBackend }),
    );

    if (typeof out === "string") throw new Error("expected structured PowerShell result");
    expect(out.sandbox).toEqual({ backend: "off" });
  });
});
