import { describe, it, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCodexImageInput, runWithLines } from "./external-agent-driver.js";
import { claudeAdapter } from "./agent-adapter.js";

describe("runWithLines（纯解析路径，无子进程）", () => {
  it("returns sessionId + finalText from collected lines", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "S1" }),
      JSON.stringify({
        type: "assistant",
        session_id: "S1",
        message: { content: [{ type: "text", text: "done" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "S1",
        result: "done",
        is_error: false,
      }),
    ];
    const r = runWithLines(claudeAdapter, lines, 0);
    expect(r.sessionId).toBe("S1");
    expect(r.finalText).toBe("done");
    expect(r.exitCode).toBe(0);
    expect(r.isError).toBe(false);
  });
});

describe("detectCodexImageInput", () => {
  it("detects -i/--image support from codex exec --help output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-image-detect-"));
    try {
      const script = join(dir, "fake-codex");
      writeFileSync(script, "#!/bin/sh\necho 'Usage: codex exec -i, --image <path>'\n", "utf-8");
      chmodSync(script, 0o755);
      expect(await detectCodexImageInput(script, dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { runAgentOnce } from "./external-agent-driver.js";
import { claudeAdapter as adp, codexAdapter } from "./agent-adapter.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { probeCli } from "./cc-capability.js";

const RUN_REAL_AGENT_TESTS = process.env.CODESHELL_RUN_REAL_AGENT_TESTS === "1";
const describeRealAgent = RUN_REAL_AGENT_TESTS ? describe : describe.skip;

describe("runAgentOnce promptViaStdin（用 cat 做可移植子进程,不依赖 claude/codex）", () => {
  // A fake adapter that drives `cat`: with promptViaStdin the driver must pipe
  // the prompt to the child's stdin, and `cat` echoes it back on stdout. This
  // exercises the real stdin-wiring code path without needing codex installed.
  it("feeds the prompt over stdin when adapter.promptViaStdin is true", async () => {
    const catAdapter: AgentAdapter = {
      kind: "cat",
      promptViaStdin: true,
      buildArgs: () => [],
      parseResult: (lines) => ({ sessionId: "", finalText: lines.join("\n"), isError: false }),
    };
    const r = await runAgentOnce(catAdapter, {
      command: "cat",
      prompt: "ECHO_ME_123",
      cwd: process.cwd(),
    });
    expect(r.finalText).toContain("ECHO_ME_123");
  }, 15_000);
});

describeRealAgent("runAgentOnce（真机集成,需 CODESHELL_RUN_REAL_AGENT_TESTS=1）", () => {
  it("spawns claude and returns a sessionId + final text", async () => {
    const avail = await probeCli("claude");
    if (!avail.available) {
      console.log("claude 未安装,跳过集成测试");
      return;
    }
    const r = await runAgentOnce(adp, {
      command: "claude",
      prompt: "Reply with exactly: PONG",
      permissionMode: "bypassPermissions",
      cwd: process.cwd(),
    });
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
    if (!avail.available) {
      console.log("claude 未安装,跳过集成测试");
      return;
    }
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

describeRealAgent("runAgentOnce codex（真机集成,需 CODESHELL_RUN_REAL_AGENT_TESTS=1）", () => {
  it("spawns codex exec, feeds the prompt over stdin, returns thread_id + final text", async () => {
    const avail = await probeCli("codex");
    if (!avail.available) {
      console.log("codex 未安装,跳过集成测试");
      return;
    }
    const r = await runAgentOnce(codexAdapter, {
      command: "codex",
      prompt: "Reply with exactly: PONG",
      permissionMode: "bypassPermissions",
      cwd: process.cwd(),
    });
    expect(r.sessionId.length).toBeGreaterThan(0); // codex thread_id
    expect(r.finalText.toUpperCase()).toContain("PONG");
  }, 120_000);
});
