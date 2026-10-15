import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DESKTOP_WORKSPACE_BUILD_ORDER } from "./build-workspace-dependencies.js";
import {
  assertMaterializedWorkspaceDependencies,
  DESKTOP_MATERIALIZED_WORKSPACES,
  readRepositoryWorkspaceNames,
} from "./materialized-workspaces.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const workspaceNames = readRepositoryWorkspaceNames(repoRoot);

function readPackage(relativeDir: string): {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(resolve(repoRoot, relativeDir, "package.json"), "utf8"));
}

describe("desktop workspace build dependencies", () => {
  test("covers every direct desktop workspace dependency", () => {
    const desktop = readPackage("packages/desktop");
    const expected = Object.entries({
      ...desktop.dependencies,
      ...desktop.devDependencies,
    })
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => name)
      .sort();

    const actual = DESKTOP_WORKSPACE_BUILD_ORDER.map<string>(
      ({ packageName }) => packageName,
    ).sort();
    expect(actual).toEqual(expected);
  });

  test("is topologically ordered for workspace dependencies", () => {
    const built = new Set<string>();
    for (const entry of DESKTOP_WORKSPACE_BUILD_ORDER) {
      const pkg = readPackage(entry.relativeDir);
      const workspaceDependencies = Object.entries(pkg.dependencies ?? {})
        .filter(([, version]) => version.startsWith("workspace:"))
        .map(([name]) => name);

      for (const dependency of workspaceDependencies) {
        expect(built.has(dependency)).toBe(true);
      }
      built.add(entry.packageName);
    }
  });

  test("builds Host after core with no server, web, or coding dependency closure", () => {
    const host = readPackage("packages/host");
    expect(Object.keys(host.dependencies ?? {})).toEqual(["@cjhyy/code-shell-core"]);
    const names = DESKTOP_WORKSPACE_BUILD_ORDER.map<string>(({ packageName }) => packageName);
    expect(names.indexOf("@cjhyy/code-shell-host")).toBeGreaterThan(
      names.indexOf("@cjhyy/code-shell-core"),
    );
    expect(names.indexOf("@cjhyy/code-shell-server")).toBeGreaterThan(
      names.indexOf("@cjhyy/code-shell-host"),
    );
  });

  test("materializes every production workspace dependency inside the packaged app", () => {
    expect(() =>
      assertMaterializedWorkspaceDependencies(readPackage("packages/desktop"), workspaceNames),
    ).not.toThrow();
    for (const { packageName, relativeDir } of DESKTOP_MATERIALIZED_WORKSPACES) {
      const manifest = readPackage(relativeDir);
      expect(manifest.name).toBe(packageName);
      expect(() => assertMaterializedWorkspaceDependencies(manifest, workspaceNames)).not.toThrow();
    }
  });

  test("rejects an unmaterialized workspace dependency before electron-builder can follow it", () => {
    for (const section of ["dependencies", "optionalDependencies"] as const) {
      const manifest = readPackage("packages/desktop");
      manifest[section] = { ...manifest[section], "@cjhyy/code-shell-host": "workspace:*" };
      expect(() => assertMaterializedWorkspaceDependencies(manifest, workspaceNames)).toThrow(
        "production workspace dependency @cjhyy/code-shell-host is not materialized by predist",
      );
    }
  });

  test("also rejects same-name local workspaces declared with semver ranges", () => {
    for (const section of ["dependencies", "optionalDependencies"] as const) {
      const manifest = readPackage("packages/desktop");
      manifest[section] = { ...manifest[section], "@cjhyy/code-shell-host": "^0.9.42" };
      expect(() => assertMaterializedWorkspaceDependencies(manifest, workspaceNames)).toThrow(
        "production workspace dependency @cjhyy/code-shell-host is not materialized by predist",
      );
    }
  });

  test("keeps the bundled Host package in build-time dependencies", () => {
    const desktop = readPackage("packages/desktop");
    expect(desktop.dependencies?.["@cjhyy/code-shell-host"]).toBeUndefined();
    expect(desktop.devDependencies?.["@cjhyy/code-shell-host"]).toBe("workspace:*");
    expect(
      DESKTOP_MATERIALIZED_WORKSPACES.map<string>(({ packageName }) => packageName),
    ).not.toContain("@cjhyy/code-shell-host");
  });
});
