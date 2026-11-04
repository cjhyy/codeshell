// Spawns a stub CLI (a shell script, never a real Claude/Codex binary) to pin
// the argv each room permission mode really launches with, and that a mode
// handoff waits until the old process is gone.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRoomAgent } from "./codex-room-agent.js";
import { ResidentAgentProcess } from "./resident-agent.js";

const dirs: string[] = [];
const previousArgsFile = process.env.CS_MOCK_CLI_ARGS_FILE;
afterEach(() => {
  if (previousArgsFile === undefined) delete process.env.CS_MOCK_CLI_ARGS_FILE;
  else process.env.CS_MOCK_CLI_ARGS_FILE = previousArgsFile;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mockCli(): { dir: string; command: string } {
  const dir = mkdtempSync(join(tmpdir(), "room-mock-cli-"));
  dirs.push(dir);
  const command = join(dir, "mock-cli");
  // Record argv, then hold stdin open like a resident CLI until EOF/signal.
  writeFileSync(
    command,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CS_MOCK_CLI_ARGS_FILE.tmp"\nmv "$CS_MOCK_CLI_ARGS_FILE.tmp" "$CS_MOCK_CLI_ARGS_FILE"\nwhile read -r line; do :; done\n',
  );
  chmodSync(command, 0o755);
  return { dir, command };
}

async function argsWritten(file: string): Promise<string[]> {
  for (let i = 0; i < 200 && !existsSync(file); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return readFileSync(file, "utf8").trimEnd().split("\n");
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("room CLI agents under a stub CLI", () => {
  for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const)
    test(`Claude Code ${mode}: actual argv carries --permission-mode ${mode} and stop waits for exit`, async () => {
      const cli = mockCli();
      const argsFile = join(cli.dir, `claude-${mode}.args`);
      process.env.CS_MOCK_CLI_ARGS_FILE = argsFile;
      const agent = new ResidentAgentProcess({
        command: cli.command,
        cwd: cli.dir,
        permissionMode: mode,
        resumeSessionId: "claude-session-1",
        onEvent: () => undefined,
      });
      agent.start();
      await agent.whenStarted();
      const args = await argsWritten(argsFile);
      expect(args).toEqual(
        ResidentAgentProcess.argsFor({ permissionMode: mode, resumeSessionId: "claude-session-1" }),
      );
      expect(args.slice(-2)).toEqual(["--permission-mode", mode]);
      expect(args).toContain("--resume");
      const pid = (agent as unknown as { lastChild?: { pid?: number } }).lastChild?.pid;
      expect(alive(pid)).toBe(true);
      await expect(agent.stopAndWait(5_000)).resolves.toBe(true);
      expect(alive(pid)).toBe(false);
    });

  for (const [mode, expected] of [
    ["default", ["--sandbox", "read-only"]],
    ["acceptEdits", ["--sandbox", "workspace-write"]],
    ["bypassPermissions", ["--dangerously-bypass-approvals-and-sandbox"]],
  ] as const)
    test(`Codex ${mode}: the turn process really launches with ${expected.join(" ")}`, async () => {
      const cli = mockCli();
      const argsFile = join(cli.dir, `codex-${mode}.args`);
      process.env.CS_MOCK_CLI_ARGS_FILE = argsFile;
      const agent = new CodexRoomAgent({
        command: cli.command,
        cwd: cli.dir,
        permissionMode: mode,
        resumeThreadId: "thread-1",
        onEvent: () => undefined,
      });
      agent.start();
      // start() only configures the next turn; no process exists yet.
      expect(agent.isBusy()).toBe(false);
      expect(agent.send("hello")).toBe(true);
      const args = await argsWritten(argsFile);
      expect(args.slice(0, 5)).toEqual([
        "exec",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
      ]);
      expect(args.slice(5, 5 + expected.length)).toEqual([...expected]);
      expect(args.slice(-3)).toEqual(["resume", "thread-1", "-"]);
      if (mode !== "bypassPermissions")
        expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      await expect(agent.stopAndWait(5_000)).resolves.toBe(true);
      expect(agent.isBusy()).toBe(false);
    });
});
