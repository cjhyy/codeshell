import { expect, test } from "bun:test";
import { createDesktopModelTraceScopeResolver } from "./desktop-model-trace-scopes.js";

test("only the paired device's authorized stable project root contributes Panel-only trace visibility", async () => {
  let allowed = true;
  const checks: Array<[string | undefined, string]> = [];
  const resolve = createDesktopModelTraceScopeResolver({
    resolveBindingProjectPath: (cwd) => (cwd === "/project/worktree" ? "/project" : cwd),
    resolveWorkspace: async (input, deviceId) => {
      checks.push([input, deviceId]);
      return allowed && deviceId === "paired" ? input : undefined;
    },
  });
  expect(await resolve("/project", "paired")).toBeUndefined();
  expect(checks).toEqual([]);
  expect(await resolve("/project/worktree", "paired")).toEqual([
    { workspacePath: "/project", sourcePrefix: "panel:" },
  ]);
  expect(await resolve("/project/worktree", "unrelated-device")).toBeUndefined();
  allowed = false;
  expect(await resolve("/project/worktree", "paired")).toBeUndefined();
  expect(checks).toEqual([
    ["/project", "paired"],
    ["/project", "unrelated-device"],
    ["/project", "paired"],
  ]);
});

test("unavailable or redirected root authority never broadens model history", async () => {
  for (const resolveWorkspace of [
    async () => "/another-project",
    async () => {
      throw new Error("Project authority unavailable");
    },
  ]) {
    const resolve = createDesktopModelTraceScopeResolver({
      resolveBindingProjectPath: () => "/project",
      resolveWorkspace,
    });
    expect(await resolve("/project/worktree", "paired")).toBeUndefined();
  }
});
