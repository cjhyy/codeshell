import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  CapabilityArtifactDetector,
  CapabilityDynamicContextProvider,
  CapabilityToolServiceHost,
  SessionManager,
  ToolContext,
} from "@cjhyy/code-shell-core/extension";
import { getCurrentBranch, getGitLog, getGitStatus } from "./git/utils.js";

export const CODING_CAPABILITY_ID = "coding";

type SetupScripts = {
  default?: string;
  macos?: string;
  linux?: string;
  windows?: string;
};

export interface CodingToolService {
  getSessionManager(): SessionManager;
  readWorktreeSetupScripts(cwd?: string): SetupScripts | undefined;
  readWorktreeBranchPrefix(cwd?: string): string | undefined;
  resolveWorktreeSetupSandbox: CapabilityToolServiceHost["resolveSandbox"];
  readWorktreeSetupShellEnv: CapabilityToolServiceHost["readShellEnv"];
}

export function createCodingToolService(host: CapabilityToolServiceHost): CodingToolService {
  return {
    getSessionManager: host.getSessionManager,
    readWorktreeSetupScripts(cwd) {
      if (host.isSubAgent || !cwd) return undefined;
      try {
        const scoped = host.settings.getForScope("project", cwd) as {
          localEnvironment?: { setupScripts?: SetupScripts };
        };
        return scoped.localEnvironment?.setupScripts;
      } catch {
        return undefined;
      }
    },
    readWorktreeBranchPrefix(cwd) {
      if (host.isSubAgent || !cwd) return undefined;
      try {
        return (host.settings.get() as { worktree?: { branchPrefix?: string } }).worktree
          ?.branchPrefix;
      } catch {
        return undefined;
      }
    },
    resolveWorktreeSetupSandbox: host.resolveSandbox,
    readWorktreeSetupShellEnv: host.readShellEnv,
  };
}

export function codingToolService(ctx?: ToolContext): CodingToolService | undefined {
  return ctx?.capabilityServices?.[CODING_CAPABILITY_ID] as CodingToolService | undefined;
}

/** Pure-filesystem repository boundary: supports both .git directories and worktree files. */
export function findCodingInstructionBoundary(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export const gitDynamicContextProvider: CapabilityDynamicContextProvider = ({ cwd, preset }) => {
  if (preset.name !== "terminal-coding") return undefined;
  const branch = getCurrentBranch(cwd);
  if (!branch) return undefined;
  const status = getGitStatus(cwd);
  const log = getGitLog(cwd, 5);
  const parts = [`gitStatus: Current branch: ${branch}`];
  if (status.length > 0) {
    parts.push(`Status:\n${status.map((entry) => `${entry.status} ${entry.path}`).join("\n")}`);
  }
  if (log.length > 0) {
    parts.push(
      `Recent commits:\n${log.map((entry) => `${entry.hash} ${entry.message}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
};

export const codingArtifactDetector: CapabilityArtifactDetector = ({ toolName, args }) => {
  if (toolName === "NotebookEdit" && typeof args.file_path === "string") {
    return {
      kind: "document",
      role: "output",
      title: args.file_path.split(/[\\/]/).pop() || args.file_path,
      locator: args.file_path,
    };
  }
  if (toolName === "Bash" && typeof args.command === "string") {
    const command = args.command.trim();
    if (/^git\s+commit\b/.test(command)) {
      return {
        kind: "resource",
        role: "output",
        title: "git commit",
        locator: "git:HEAD",
        metadata: { command: command.slice(0, 200) },
      };
    }
  }
  return undefined;
};
