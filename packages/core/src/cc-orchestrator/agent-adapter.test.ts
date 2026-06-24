import { describe, it, expect } from "bun:test";
import { claudeAdapter } from "./agent-adapter.js";

describe("claudeAdapter.buildArgs", () => {
  it("includes core headless flags + permission mode", () => {
    const args = claudeAdapter.buildArgs({ prompt: "hi", permissionMode: "default", cwd: "/x" });
    expect(args.slice(0, 5)).toEqual(["-p", "hi", "--output-format", "stream-json", "--verbose"]);
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
  });
  it("hard-disallows Workflow (the token-burn culprit), NOT Task", () => {
    // Workflow fans out a fleet of agents — the real token sink. A single Task
    // (one sub-agent) is cheap, so it stays allowed. (Earlier we mistakenly
    // disallowed Task; corrected here.)
    const args = claudeAdapter.buildArgs({ prompt: "hi", permissionMode: "bypassPermissions", cwd: "/x" });
    expect(args).toContain("--disallowedTools");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Workflow");
    expect(args).not.toContain("Task");
  });
  it("appends a system prompt asking CC to check before running a Workflow", () => {
    const args = claudeAdapter.buildArgs({ prompt: "hi", permissionMode: "default", cwd: "/x" });
    expect(args).toContain("--append-system-prompt");
    const injected = args[args.indexOf("--append-system-prompt") + 1];
    expect(injected.toLowerCase()).toContain("workflow");
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
