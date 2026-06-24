import { describe, it, expect } from "bun:test";
import { claudeAdapter } from "./agent-adapter.js";

describe("claudeAdapter.buildArgs", () => {
  it("always includes -p, stream-json, --verbose, and disallows Task", () => {
    const args = claudeAdapter.buildArgs({ prompt: "hi", permissionMode: "default", cwd: "/x" });
    expect(args).toEqual([
      "-p", "hi", "--output-format", "stream-json", "--verbose",
      // Task (sub-agent / workflow) is the token-burn culprit when driving CC
      // unattended — disallow it so a driven CC can't recursively fan out
      // workflows. Always present, regardless of permission mode.
      "--disallowedTools", "Task",
      "--permission-mode", "default",
    ]);
  });
  it("adds --resume <id> when resumeSessionId present", () => {
    const args = claudeAdapter.buildArgs({ prompt: "go", resumeSessionId: "S1", permissionMode: "bypassPermissions", cwd: "/x" });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("S1");
    expect(args).toContain("--verbose");
  });
});

describe("claudeAdapter.parseResult", () => {
  it("extracts sessionId + finalText from the result line", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "S9" }),
      JSON.stringify({ type: "assistant", session_id: "S9", message: { content: [{ type: "text", text: "PONG" }] } }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "S9", result: "PONG", is_error: false }),
    ];
    const r = claudeAdapter.parseResult(lines);
    expect(r.sessionId).toBe("S9");
    expect(r.finalText).toBe("PONG");
    expect(r.isError).toBe(false);
  });
  it("falls back to init session_id when no result line", () => {
    const r = claudeAdapter.parseResult([JSON.stringify({ type: "system", subtype: "init", session_id: "S2" })]);
    expect(r.sessionId).toBe("S2");
    expect(r.finalText).toBe("");
  });
});
