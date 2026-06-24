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

  // The load-bearing guarantee behind "靠一个 session id 串起整件事": passing a
  // prior run's sessionId as resumeSessionId must make `claude --resume <id>`
  // continue the SAME conversation, so CC actually remembers earlier context.
  // Without this, multi-step chaining (task A done → resume its session for the
  // related next step) silently loses context. Skips when claude isn't installed.
  it("resume continues the SAME session with prior context (CC remembers)", async () => {
    const avail = await probeCli("claude");
    if (!avail.available) { console.log("claude 未安装,跳过集成测试"); return; }
    // Turn 1: have CC memorize a distinctive token.
    const first = await runAgentOnce(adp, {
      command: "claude",
      prompt: "Remember this exact codeword for later: ZEBRA42. Reply with only: OK",
      permissionMode: "bypassPermissions",
      cwd: process.cwd(),
    });
    expect(first.sessionId.length).toBeGreaterThan(0);
    // Turn 2: resume that session and ask for the codeword — without re-stating it.
    const second = await runAgentOnce(adp, {
      command: "claude",
      prompt: "What was the exact codeword I asked you to remember? Reply with only that word.",
      resumeSessionId: first.sessionId,
      permissionMode: "bypassPermissions",
      cwd: process.cwd(),
    });
    // Same conversation → CC recalls the token from turn 1's context.
    expect(second.finalText.toUpperCase()).toContain("ZEBRA42");
  }, 120_000);
});
