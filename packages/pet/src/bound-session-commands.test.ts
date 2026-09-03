import { describe, expect, test } from "bun:test";
import {
  boundSessionStalePrompt,
  isApprovalDecision,
  parseBoundSessionCommand,
  shouldForwardBoundReply,
} from "./bound-session-commands.js";

describe("leaving", () => {
  test("recognizes the documented ways out", () => {
    for (const command of ["/mimi", "/session leave", "返回 Mimi", "退出 Session"]) {
      expect(parseBoundSessionCommand(command)).toBe("leave");
    }
  });

  test("tolerates surrounding whitespace and case", () => {
    expect(parseBoundSessionCommand("  /MIMI  ")).toBe("leave");
    expect(parseBoundSessionCommand("/session   leave")).toBe("leave");
  });

  test("never swallows a real message that merely mentions leaving", () => {
    // Losing user input into a control path is worse than requiring the
    // exact command.
    for (const message of [
      "我想退出这个 Session 之后再看看别的",
      "帮我问问 mimi",
      "/mimi 帮我看看",
      "leave",
    ]) {
      expect(parseBoundSessionCommand(message)).toBeUndefined();
    }
  });
});

describe("status", () => {
  test("recognizes the status commands", () => {
    expect(parseBoundSessionCommand("/session")).toBe("status");
    expect(parseBoundSessionCommand("/session status")).toBe("status");
  });
});

describe("which replies reach the chat", () => {
  test("forwards the final answer, decisions and the terminal notice", () => {
    for (const kind of ["final", "decision", "terminal"] as const) {
      expect(shouldForwardBoundReply({ kind, text: "done" })).toBe(true);
    }
  });

  test("never forwards the intermediate stream", () => {
    // Tool arguments and raw results stay inside the Session.
    for (const kind of ["partial", "tool", "progress"] as const) {
      expect(shouldForwardBoundReply({ kind, text: "reading file" })).toBe(false);
    }
  });

  test("drops an empty final rather than sending a blank message", () => {
    expect(shouldForwardBoundReply({ kind: "final", text: "   " })).toBe(false);
  });
});

describe("approvals", () => {
  test("plain text is never an approval", () => {
    // A chat message that looks like consent must not authorize a
    // destructive action; approvals carry a signed one-time token.
    for (const message of ["同意", "yes", "approve", "ok 继续", "允许"]) {
      expect(isApprovalDecision(message)).toBe(false);
    }
  });
});

describe("stale prompt", () => {
  test("names the Session and how to get out", () => {
    const prompt = boundSessionStalePrompt("修复登录问题");
    expect(prompt.hint).toContain("修复登录问题");
    expect(prompt.hint).toContain("/mimi");
  });
});
