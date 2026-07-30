import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPanelAppBound,
  resolvePanelAppBindingPolicy,
  resolvePanelAppBindingProjectPath,
} from "./bindings.js";

describe("Panel App project bindings", () => {
  test("installed apps are unavailable until a project explicitly binds them", () => {
    const policy = resolvePanelAppBindingPolicy({}, {}, true);
    expect(isPanelAppBound("design-studio", policy)).toBe(false);
  });

  test("a binding is project-local and the global master switch still wins", () => {
    const enabled = resolvePanelAppBindingPolicy({}, { panelAppBindings: ["design-studio"] }, true);
    expect(isPanelAppBound("design-studio", enabled)).toBe(true);
    expect(isPanelAppBound("quant-lab", enabled)).toBe(false);

    const globallyDisabled = resolvePanelAppBindingPolicy(
      { disabledPanelApps: ["design-studio"] },
      { panelAppBindings: ["design-studio"] },
      true,
    );
    expect(isPanelAppBound("design-studio", globallyDisabled)).toBe(false);
  });

  test("no-project contexts fail closed and legacy explicit on migrates as a binding", () => {
    const noProject = resolvePanelAppBindingPolicy(
      {},
      { panelAppBindings: ["design-studio"] },
      false,
    );
    expect(isPanelAppBound("design-studio", noProject)).toBe(false);

    const legacy = resolvePanelAppBindingPolicy(
      {},
      { panelAppOverrides: { "design-studio": "on", "quant-lab": "off" } },
      true,
    );
    expect(isPanelAppBound("design-studio", legacy)).toBe(true);
    expect(isPanelAppBound("quant-lab", legacy)).toBe(false);
  });

  test("a Git worktree inherits bindings from its owning project", () => {
    const root = mkdtempSync(join(tmpdir(), "panel-app-binding-"));
    const project = join(root, "project");
    const worktree = join(root, "worktree");
    mkdirSync(join(project, ".git", "worktrees", "task"), { recursive: true });
    mkdirSync(join(worktree, "nested"), { recursive: true });
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(project, ".git", "worktrees", "task")}\n`,
    );
    try {
      expect(resolvePanelAppBindingProjectPath(join(worktree, "nested"))).toBe(project);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
