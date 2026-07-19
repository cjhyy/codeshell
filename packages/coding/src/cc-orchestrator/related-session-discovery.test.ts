import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalAgentSessionBinding } from "./external-agent-session-store.js";
import { countRelatedSessions, discoverRelatedSessions } from "./related-session-discovery.js";
import { encodeCwd } from "./session-discovery.js";

function binding(
  cli: "claude" | "codex",
  sessionId: string,
  cwd: string,
  workspaceRoot: string,
): ExternalAgentSessionBinding {
  return {
    cli,
    sessionId,
    cwd,
    workspaceRoot,
    createdAt: 1,
    lastUsedAt: 1,
    updatedAt: 1,
  };
}

function writeClaudeSession(home: string, cwd: string, sessionId: string, prompt: string): void {
  const dir = join(home, "projects", encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n",
  );
}

function writeCodexSession(home: string, cwd: string, sessionId: string, prompt: string): void {
  const dir = join(home, "sessions", "2026", "07", "18");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-${sessionId}.jsonl`),
    [
      { type: "session_meta", payload: { id: sessionId, cwd } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
}

describe("discoverRelatedSessions", () => {
  it("includes delegated Claude worktrees and retains their authoritative cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-related-"));
    const root = "/repo/main";
    const worktree = "/repo/.worktrees/delegated";
    writeClaudeSession(home, root, "native", "main prompt");
    writeClaudeSession(home, worktree, "delegated", "delegated prompt");
    writeClaudeSession(home, worktree, "unbound", "not this project");

    const sessions = discoverRelatedSessions(
      "claude",
      root,
      {},
      {
        claudeHome: home,
        bindings: [binding("claude", "delegated", worktree, root)],
      },
    );

    expect(new Set(sessions.map(({ sessionId, cwd }) => `${sessionId}:${cwd}`))).toEqual(
      new Set([`native:${root}`, `delegated:${worktree}`]),
    );
    expect(
      countRelatedSessions("claude", root, {
        claudeHome: home,
        bindings: [binding("claude", "delegated", worktree, root)],
      }),
    ).toBe(2);
  });

  it("finds related Codex cwd buckets in one project-visible list", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-related-"));
    const root = "/repo/main";
    const worktree = "/repo/.worktrees/delegated";
    writeCodexSession(home, root, "native", "main prompt");
    writeCodexSession(home, worktree, "delegated", "delegated prompt");
    writeCodexSession(home, "/other", "other", "other prompt");

    const sessions = discoverRelatedSessions(
      "codex",
      root,
      {},
      {
        codexHome: home,
        bindings: [binding("codex", "delegated", worktree, root)],
      },
    );

    expect(new Set(sessions.map((session) => session.sessionId))).toEqual(
      new Set(["native", "delegated"]),
    );
    expect(sessions.find((session) => session.sessionId === "delegated")?.cwd).toBe(worktree);
    expect(
      countRelatedSessions("codex", root, {
        codexHome: home,
        bindings: [binding("codex", "delegated", worktree, root)],
      }),
    ).toBe(2);
  });
});
