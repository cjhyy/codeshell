import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptComposer } from "./composer.js";
import {
  createWorkspaceContext,
  legacySingleRootWorkspace,
} from "../workspace/workspace-context.js";

describe("PromptComposer workspace runtime header", () => {
  test("preserves cwd-only callers with a legacy single-root workspace", async () => {
    const cwd = process.cwd();
    const expectedWorkspace = legacySingleRootWorkspace(cwd);

    const prompt = await new PromptComposer({ cwd, model: "test-model" }).buildSystemPrompt([]);

    expect(prompt).toContain("Workspace roots (1):");
    expect(prompt).toContain(
      `- [primary] ${expectedWorkspace.roots[0]!.path} (rootId: legacy-root)`,
    );
  });

  test("renders every root from an explicit multi-root workspace", async () => {
    const primary = join(tmpdir(), "codeshell-composer-main");
    const secondary = join(tmpdir(), "codeshell-composer-docs");
    const workspace = createWorkspaceContext({
      projectId: "project-1",
      projectRevision: 1,
      sessionMainRootId: "root-main",
      roots: [
        { id: "root-main", path: primary, role: "primary" },
        { id: "root-docs", path: secondary, role: "secondary" },
      ],
    });

    const prompt = await new PromptComposer({
      cwd: primary,
      workspace,
      model: "test-model",
    }).buildSystemPrompt([]);

    expect(prompt).toContain("Workspace roots (2):");
    expect(prompt).toContain(`- [primary] ${primary} (rootId: root-main)`);
    expect(prompt).toContain(`- [secondary] ${secondary} (rootId: root-docs)`);
  });

  test("rejects an invalid explicit workspace instead of falling back", () => {
    const cwd = process.cwd();
    const invalidWorkspace = {
      ...legacySingleRootWorkspace(cwd),
      rootsDigest: "forged",
    };

    expect(
      () => new PromptComposer({ cwd, workspace: invalidWorkspace, model: "test-model" }),
    ).toThrow("rootsDigest");
  });
});
