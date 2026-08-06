import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DESKTOP_WORKSPACE_BUILD_ORDER } from "./build-workspace-dependencies.js";

const repoRoot = resolve(import.meta.dir, "../../..");

function readPackage(relativeDir: string): {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
});
