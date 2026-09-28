import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PanelExecutionGate } from "./execution-gate.js";
import { panelPackageMutationMatches } from "./package-mutation.js";

test("project aliases and worktrees share the main project's mutation barrier", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "panel-mutation-project-")));
  try {
    const project = join(root, "main"),
      alias = join(root, "alias"),
      worktree = join(root, "worktree");
    await mkdir(join(project, ".git/worktrees/fixture"), { recursive: true });
    await mkdir(join(project, ".code-shell"));
    await writeFile(
      join(project, ".code-shell/settings.json"),
      JSON.stringify({
        panelAppPins: {
          fixture: { version: "1", packageDigest: "a".repeat(64) },
        },
      }),
    );
    await symlink(project, alias);
    await mkdir(worktree);
    await writeFile(join(worktree, ".git"), `gitdir: ${join(alias, ".git/worktrees/fixture")}\n`);
    const gate = new PanelExecutionGate();
    const matches = panelPackageMutationMatches({
      appId: "fixture",
      projectPath: project,
      kind: "update",
    });
    for (const projectPath of [alias, worktree]) {
      const release = gate.enter({ appId: "fixture", projectPath });
      try {
        await expect(gate.mutate(matches, async () => {})).rejects.toThrow("正在提交");
      } finally {
        release();
      }
    }
    await gate.mutate(matches, async () => {
      expect(() => gate.enter({ appId: "fixture", projectPath: alias })).toThrow("正在更新");
      expect(() => gate.enter({ appId: "fixture", projectPath: worktree })).toThrow("正在更新");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
