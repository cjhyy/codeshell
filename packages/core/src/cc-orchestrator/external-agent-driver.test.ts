import { describe, it, expect } from "bun:test";
import { runWithLines } from "./external-agent-driver.js";
import { claudeAdapter } from "./agent-adapter.js";

describe("runWithLines（纯解析路径，无子进程）", () => {
  it("returns sessionId + finalText from collected lines", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "S1" }),
      JSON.stringify({ type: "assistant", session_id: "S1", message: { content: [{ type: "text", text: "done" }] } }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "S1", result: "done", is_error: false }),
    ];
    const r = runWithLines(claudeAdapter, lines, 0);
    expect(r.sessionId).toBe("S1");
    expect(r.finalText).toBe("done");
    expect(r.exitCode).toBe(0);
    expect(r.isError).toBe(false);
  });
});

import { runAgentOnce } from "./external-agent-driver.js";
import { claudeAdapter as adp } from "./agent-adapter.js";
import { probeCli } from "./cc-capability.js";

describe("runAgentOnce（真机集成,无 CLI 自动跳过）", () => {
  it("spawns claude and returns a sessionId + final text", async () => {
    const avail = await probeCli("claude");
    if (!avail.available) { console.log("claude 未安装,跳过集成测试"); return; }
    const r = await runAgentOnce(adp, { command: "claude", prompt: "Reply with exactly: PONG", permissionMode: "bypassPermissions", cwd: process.cwd() });
    expect(r.sessionId.length).toBeGreaterThan(0);
    expect(r.finalText.toUpperCase()).toContain("PONG");
  }, 90_000);
});
