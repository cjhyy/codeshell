import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChild(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function waitForStdout(child: ReturnType<typeof spawn>, text: string): Promise<void> {
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  return new Promise((resolve) => {
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes(text)) resolve();
    });
  });
}

describe("ExternalAgentSessionStore", () => {
  it("persists cwd bindings keyed by cli + sessionId", () => {
    const dir = mkdtempSync(join(tmpdir(), "external-agent-store-"));
    try {
      const file = join(dir, "sessions.json");
      const a = new ExternalAgentSessionStore(file);
      a.record({ cli: "claude", sessionId: "S1", cwd: "/repo/a" });
      a.record({ cli: "codex", sessionId: "S1", cwd: "/repo/b" });

      const b = new ExternalAgentSessionStore(file);
      expect(b.get("claude", "S1")?.cwd).toBe("/repo/a");
      expect(b.get("codex", "S1")?.cwd).toBe("/repo/b");
      expect(b.list().map(({ cli, sessionId, cwd }) => ({ cli, sessionId, cwd }))).toEqual([
        { cli: "claude", sessionId: "S1", cwd: "/repo/a" },
        { cli: "codex", sessionId: "S1", cwd: "/repo/b" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates an existing binding and preserves optional worktree fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "external-agent-store-"));
    try {
      const file = join(dir, "sessions.json");
      const store = new ExternalAgentSessionStore(file);

      store.record({ cli: "claude", sessionId: "S1", cwd: "/repo/old" });
      store.record({
        cli: "claude",
        sessionId: "S1",
        cwd: "/repo/new",
        worktreePath: "/repo/new",
        worktreeBranch: "agent/s1",
      });

      expect(store.get("claude", "S1")).toMatchObject({
        cli: "claude",
        sessionId: "S1",
        cwd: "/repo/new",
        worktreePath: "/repo/new",
        worktreeBranch: "agent/s1",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes cwd before storing", () => {
    const dir = mkdtempSync(join(tmpdir(), "external-agent-store-cwd-"));
    const prevCwd = process.cwd();
    try {
      const project = join(dir, "project");
      mkdirSync(project);
      process.chdir(dir);
      const store = new ExternalAgentSessionStore(join(dir, "sessions.json"));

      store.record({ cli: "claude", sessionId: "S1", cwd: "project/" });

      expect(store.get("claude", "S1")?.cwd).toBe(realpathSync(project));
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves interleaved upserts from concurrent writers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "external-agent-store-race-"));
    try {
      const file = join(dir, "sessions.json");
      const firstCwd = join(dir, "first");
      const secondCwd = join(dir, "second");
      mkdirSync(firstCwd);
      mkdirSync(secondCwd);

      // Simulate writer A holding the store lock while writer B starts. The
      // pre-fix store ignored this directory, letting B save a stale snapshot
      // that A then overwrote below.
      mkdirSync(`${file}.lock`);
      const moduleUrl = pathToFileURL(
        join(process.cwd(), "packages/coding/src/cc-orchestrator/external-agent-session-store.ts"),
      ).href;
      const child = spawn(
        process.execPath,
        [
          "--eval",
          `
          import { ExternalAgentSessionStore } from ${JSON.stringify(moduleUrl)};
          process.stdout.write("ready\\n");
          new ExternalAgentSessionStore(${JSON.stringify(file)}).record({
            cli: "claude",
            sessionId: "S2",
            cwd: ${JSON.stringify(secondCwd)}
          });
        `,
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const childDone = waitForChild(child);
      await Promise.race([
        waitForStdout(child, "ready"),
        childDone.then((result) => {
          throw new Error(`child exited before ready (code ${result.code}): ${result.stderr}`);
        }),
      ]);
      const exitedBeforeUnlock = await Promise.race([
        childDone.then(() => true),
        delay(300).then(() => false),
      ]);

      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          sessions: [
            {
              cli: "claude",
              sessionId: "S1",
              cwd: firstCwd,
              updatedAt: 1,
            },
          ],
        }) + "\n",
        "utf-8",
      );
      rmSync(`${file}.lock`, { recursive: true, force: true });

      const childResult = await childDone;
      expect(childResult.code).toBe(0);
      expect(childResult.stderr).toBe("");
      expect(exitedBeforeUnlock).toBe(false);

      const store = new ExternalAgentSessionStore(file);
      expect(store.get("claude", "S1")?.cwd).toBe(realpathSync(firstCwd));
      expect(store.get("claude", "S2")?.cwd).toBe(realpathSync(secondCwd));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for missing or invalid records", () => {
    const dir = mkdtempSync(join(tmpdir(), "external-agent-store-"));
    try {
      const store = new ExternalAgentSessionStore(join(dir, "sessions.json"));
      expect(store.get("claude", "missing")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
