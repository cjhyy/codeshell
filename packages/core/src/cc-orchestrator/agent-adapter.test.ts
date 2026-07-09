import { describe, it, expect } from "bun:test";
import { claudeAdapter, codexAdapter } from "./agent-adapter.js";

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
    const args = claudeAdapter.buildArgs({
      prompt: "hi",
      permissionMode: "bypassPermissions",
      cwd: "/x",
    });
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
    const args = claudeAdapter.buildArgs({
      prompt: "go",
      resumeSessionId: "S1",
      permissionMode: "bypassPermissions",
      cwd: "/x",
    });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("S1");
    expect(args).toContain("--verbose");
  });
});

describe("claudeAdapter.parseResult", () => {
  it("extracts sessionId + finalText from the result line", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "S9" }),
      JSON.stringify({
        type: "assistant",
        session_id: "S9",
        message: { content: [{ type: "text", text: "PONG" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "S9",
        result: "PONG",
        is_error: false,
      }),
    ];
    const r = claudeAdapter.parseResult(lines);
    expect(r.sessionId).toBe("S9");
    expect(r.finalText).toBe("PONG");
    expect(r.isError).toBe(false);
  });
  it("falls back to init session_id when no result line", () => {
    const r = claudeAdapter.parseResult([
      JSON.stringify({ type: "system", subtype: "init", session_id: "S2" }),
    ]);
    expect(r.sessionId).toBe("S2");
    expect(r.finalText).toBe("");
  });
});

describe("codexAdapter.buildArgs", () => {
  it("uses `codex exec --json` with read-only sandbox for default mode + stdin prompt marker", () => {
    const args = codexAdapter.buildArgs({ prompt: "hi", permissionMode: "default", cwd: "/x" });
    expect(args.slice(0, 4)).toEqual(["exec", "--json", "--color", "never"]);
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    // prompt is fed via stdin (promptViaStdin), so the bare `-` marker is last
    // and the prompt text is NOT in argv.
    expect(args[args.length - 1]).toBe("-");
    expect(args).not.toContain("hi");
  });
  it("maps acceptEdits → workspace-write sandbox", () => {
    const args = codexAdapter.buildArgs({ prompt: "hi", permissionMode: "acceptEdits", cwd: "/x" });
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });
  it("maps bypassPermissions → --dangerously-bypass-approvals-and-sandbox (no --sandbox)", () => {
    const args = codexAdapter.buildArgs({
      prompt: "hi",
      permissionMode: "bypassPermissions",
      cwd: "/x",
    });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--sandbox");
  });
  it("adds `resume <id> -` when resumeSessionId present", () => {
    const args = codexAdapter.buildArgs({
      prompt: "go",
      resumeSessionId: "T1",
      permissionMode: "default",
      cwd: "/x",
    });
    const i = args.indexOf("resume");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("T1");
    expect(args[i + 2]).toBe("-");
  });
  it("declares promptViaStdin so the driver feeds the prompt over stdin", () => {
    expect(codexAdapter.promptViaStdin).toBe(true);
  });
  it("adds -i image paths only when Codex image input is detected", () => {
    const args = codexAdapter.buildArgs({
      prompt: "go",
      permissionMode: "default",
      cwd: "/x",
      imagePaths: ["/x/a.png", "/x/b.jpg"],
      codexImageInputSupported: true,
    });
    expect(args).toContain("-i");
    expect(args).toContain("/x/a.png");
    expect(args).toContain("/x/b.jpg");
  });
  it("omits -i image paths when Codex image input is not detected", () => {
    const args = codexAdapter.buildArgs({
      prompt: "go",
      permissionMode: "default",
      cwd: "/x",
      imagePaths: ["/x/a.png"],
      codexImageInputSupported: false,
    });
    expect(args).not.toContain("-i");
    expect(args).not.toContain("/x/a.png");
  });
  it("claude adapter ignores image paths rather than passing unknown flags", () => {
    const args = claudeAdapter.buildArgs({
      prompt: "go",
      permissionMode: "default",
      cwd: "/x",
      imagePaths: ["/x/a.png"],
      codexImageInputSupported: true,
    });
    expect(args).not.toContain("-i");
    expect(args).not.toContain("/x/a.png");
  });
});

describe("codexAdapter.parseResult", () => {
  it("extracts thread_id as sessionId and the last agent_message as finalText", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "019f-abc" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "i0", type: "command_execution", aggregated_output: "hi\n", exit_code: 0 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "done" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ];
    const r = codexAdapter.parseResult(lines);
    expect(r.sessionId).toBe("019f-abc");
    expect(r.finalText).toBe("done");
    expect(r.isError).toBe(false);
  });
  it("takes the LAST agent_message when several are emitted", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "T" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "last" } }),
    ];
    expect(codexAdapter.parseResult(lines).finalText).toBe("last");
  });
  it("flags isError on turn.failed and surfaces the failure message", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "T" }),
      JSON.stringify({ type: "turn.failed", error: { message: "model exploded" } }),
    ];
    const r = codexAdapter.parseResult(lines);
    expect(r.isError).toBe(true);
    expect(r.finalText).toContain("model exploded");
  });
  it("flags isError on a standalone error event", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "T" }),
      JSON.stringify({ type: "error", message: "boom" }),
    ];
    const r = codexAdapter.parseResult(lines);
    expect(r.isError).toBe(true);
    expect(r.finalText).toContain("boom");
  });
});
