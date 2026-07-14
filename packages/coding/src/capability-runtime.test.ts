import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ArtifactTracker,
  createOffBackend,
  type RunArtifactRef,
  type RunStore,
} from "@cjhyy/code-shell-core";
import {
  codingArtifactDetector,
  createCodingToolService,
  findCodingInstructionBoundary,
  gitDynamicContextProvider,
} from "./capability-runtime.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("coding capability runtime", () => {
  it("owns repository boundary and volatile status context outside core", async () => {
    const repo = mkdtempSync(join(tmpdir(), "coding-context-"));
    dirs.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "tracked.txt"), "first\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
    const nested = join(repo, "nested");
    writeFileSync(join(repo, "untracked.txt"), "new\n");

    expect(findCodingInstructionBoundary(nested)).toBe(repo);
    const context = await gitDynamicContextProvider({
      cwd: repo,
      preset: {
        name: "terminal-coding",
        label: "Coding",
        description: "Coding",
        promptSections: [],
        builtinTools: [],
        defaultPermissionRules: [],
      },
    });
    expect(context).toContain("Current branch:");
    expect(context).toContain("untracked.txt");
    expect(context).toContain("initial");
  });

  it("builds worktree configuration as a coding-private tool service", async () => {
    const manager = {} as never;
    const service = createCodingToolService({
      isSubAgent: false,
      settings: {
        get: () => ({ worktree: { branchPrefix: "feature/" } }),
        getForScope: () => ({
          localEnvironment: { setupScripts: { default: "bun install" } },
        }),
      },
      resolveSandbox: async () => createOffBackend(),
      readShellEnv: (cwd) => ({ ACTIVE_CWD: cwd ?? "" }),
      getSessionManager: () => manager,
    });

    expect(service.readWorktreeBranchPrefix("/repo")).toBe("feature/");
    expect(service.readWorktreeSetupScripts("/repo")).toEqual({ default: "bun install" });
    expect(await service.resolveWorktreeSetupSandbox("/repo")).toMatchObject({ name: "off" });
    expect(service.readWorktreeSetupShellEnv("/repo")).toEqual({ ACTIVE_CWD: "/repo" });
    expect(service.getSessionManager()).toBe(manager);
  });

  it("contributes notebook and commit artifact detection", async () => {
    const refs: RunArtifactRef[] = [];
    const tracker = new ArtifactTracker({
      runId: "coding-artifacts",
      detectors: [codingArtifactDetector],
      store: {
        appendArtifactRef: async (ref: RunArtifactRef) => {
          refs.push(ref);
        },
      } as RunStore,
    });

    await tracker.onStreamEvent({
      type: "tool_use_start",
      toolCall: { id: "notebook", toolName: "NotebookEdit", args: { file_path: "lab.ipynb" } },
    });
    await tracker.onStreamEvent({
      type: "tool_result",
      result: { id: "notebook", result: "ok", isError: false },
    });
    await tracker.onStreamEvent({
      type: "tool_use_start",
      toolCall: { id: "commit", toolName: "Bash", args: { command: "git commit -m done" } },
    });
    await tracker.onStreamEvent({
      type: "tool_result",
      result: { id: "commit", result: "ok", isError: false },
    });

    expect(refs.map((ref) => ref.locator)).toEqual(["lab.ipynb", "git:HEAD"]);
  });
});
