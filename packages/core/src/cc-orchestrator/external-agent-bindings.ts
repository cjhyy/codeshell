import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { codeShellHome, SessionManager } from "../session/session-manager.js";

export type ExternalAgentCli = "claude" | "codex";

export interface ExternalAgentRunBinding {
  cli: ExternalAgentCli;
  externalSessionId: string;
  codeShellSessionId: string;
  cwd: string;
  worktreePath?: string;
  worktreeBranch?: string;
  createdAt: number;
  lastUsedAt: number;
}

interface ExternalAgentBindingsFile {
  bindings: Record<string, ExternalAgentRunBinding>;
}

export function externalAgentBindingsPath(home = codeShellHome()): string {
  return join(home, "external-agents", "bindings.json");
}

export class ExternalAgentBindingStore {
  constructor(private readonly filePath?: string) {}

  get(externalSessionId: string): ExternalAgentRunBinding | undefined {
    return this.read({ failOnCorrupt: true }).bindings[externalSessionId];
  }

  upsert(next: Omit<ExternalAgentRunBinding, "createdAt" | "lastUsedAt">): ExternalAgentRunBinding {
    const data = this.read({ failOnCorrupt: false });
    const existing = data.bindings[next.externalSessionId];
    const now = Date.now();
    const binding: ExternalAgentRunBinding = {
      ...next,
      codeShellSessionId: next.codeShellSessionId || existing?.codeShellSessionId || "",
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    data.bindings[next.externalSessionId] = binding;
    this.write(data);
    return binding;
  }

  private read(opts: { failOnCorrupt: boolean }): ExternalAgentBindingsFile {
    const file = this.file();
    if (!existsSync(file)) return { bindings: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<ExternalAgentBindingsFile>;
      if (parsed && typeof parsed.bindings === "object" && parsed.bindings) {
        return { bindings: parsed.bindings as Record<string, ExternalAgentRunBinding> };
      }
      if (opts.failOnCorrupt) {
        throw new Error(`external agent bindings file is corrupt: expected object with bindings`);
      }
      return { bindings: {} };
    } catch (err) {
      if (opts.failOnCorrupt) {
        throw new Error(
          `external agent bindings file is corrupt or unreadable: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      return { bindings: {} };
    }
  }

  private write(data: ExternalAgentBindingsFile): void {
    const file = this.file();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, file);
  }

  private file(): string {
    return this.filePath ?? externalAgentBindingsPath();
  }
}

export function detectExternalAgentWorktree(cwd: string): {
  worktreePath?: string;
  worktreeBranch?: string;
} {
  if (!existsSync(cwd)) return {};
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    const branch = git(root, ["branch", "--show-current"]);
    const entries = parseWorktreeList(git(root, ["worktree", "list", "--porcelain"]));
    const current = entries.find((entry) => resolve(entry.path) === resolve(root));
    const main = entries[0];
    if (!current || !branch || !main || resolve(current.path) === resolve(main.path)) return {};
    return { worktreePath: root, worktreeBranch: branch };
  } catch {
    return {};
  }
}

export function externalAgentResumeCwdError(binding: ExternalAgentRunBinding): string | undefined {
  if (existsSync(binding.cwd)) return undefined;
  const branch = binding.worktreeBranch;
  if (branch && branchExistsForBinding(binding)) {
    return (
      `Error: external ${binding.cli} session ${binding.externalSessionId} is bound to cwd ` +
      `${binding.cwd}, but that directory no longer exists. Worktree branch ${branch} still ` +
      `exists; recreate the worktree at ${binding.worktreePath ?? binding.cwd} before resuming.`
    );
  }
  return (
    `Error: external ${binding.cli} session ${binding.externalSessionId} is bound to cwd ` +
    `${binding.cwd}, but the workspace deleted${branch ? ` and branch ${branch} is gone` : ""}. ` +
    `Start a new external session.`
  );
}

function branchExistsForBinding(binding: ExternalAgentRunBinding): boolean {
  if (!binding.worktreeBranch) return false;
  for (const cwd of candidateGitCwds(binding)) {
    if (!cwd || !existsSync(cwd)) continue;
    try {
      const out = git(cwd, ["branch", "--list", binding.worktreeBranch]);
      if (out.length > 0) return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

function candidateGitCwds(binding: ExternalAgentRunBinding): string[] {
  const candidates = new Set<string>();
  if (existsSync(binding.cwd)) candidates.add(binding.cwd);
  if (binding.codeShellSessionId) {
    const sessionCwd = new SessionManager().readCwd(binding.codeShellSessionId);
    if (sessionCwd) candidates.add(sessionCwd);
  }
  candidates.add(process.cwd());
  candidates.add(dirname(binding.cwd));
  candidates.add(dirname(dirname(binding.cwd)));
  return [...candidates];
}

function parseWorktreeList(raw: string): Array<{ path: string; branch: string }> {
  if (!raw.trim()) return [];
  const entries: Array<{ path: string; branch: string }> = [];
  let current: { path: string; branch: string } = { path: "", branch: "" };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current);
      current = { path: line.slice(9), branch: "" };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    }
  }
  if (current.path) entries.push(current);
  return entries;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export const externalAgentBindingStore = new ExternalAgentBindingStore();
