import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  AUDITED_RELEASE_PACKAGES,
  PRIVATE_VERSIONED_PACKAGES,
  PUBLIC_RELEASE_PACKAGES,
  RELEASE_PACKAGES,
  packageManifestPath,
  validatePublicReleaseOrder,
  validatePublishManifest,
} from "../scripts/package-release-audit-config";
import { publishCommands } from "../scripts/publish-release-packages";
import { collectReleaseVersionErrors } from "../scripts/verify-release-versions";

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: {
    access?: string;
  };
  main?: string;
  types?: string;
  exports?: Record<string, string | { types?: string; import?: string }>;
  files?: string[];
  engines?: {
    node?: string;
  };
  repository?: {
    type?: string;
    url?: string;
    directory?: string;
  };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const repoRoot = process.cwd();

async function loadManifest(path: string): Promise<PackageManifest> {
  return Bun.file(path).json();
}

async function workspaceManifests(): Promise<Map<string, PackageManifest>> {
  const manifests = new Map<string, PackageManifest>();
  const root = await loadManifest(join(repoRoot, "package.json"));
  manifests.set(root.name, root);
  for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = await loadManifest(join(repoRoot, "packages", entry.name, "package.json"));
    manifests.set(manifest.name, manifest);
  }
  return manifests;
}

function dependencyNames(manifest: PackageManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path))
    .map((path) => join(root, path));
}

describe("workspace package boundaries", () => {
  it("keeps the workspace dependency graph acyclic", async () => {
    const manifests = await workspaceManifests();
    const workspaceNames = new Set(manifests.keys());
    const graph = new Map(
      [...manifests].map(([name, manifest]) => [
        name,
        dependencyNames(manifest).filter((dependency) => workspaceNames.has(dependency)),
      ]),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (name: string, path: string[]): void => {
      if (visiting.has(name)) {
        throw new Error(`workspace dependency cycle: ${[...path, name].join(" -> ")}`);
      }
      if (visited.has(name)) return;
      visiting.add(name);
      for (const dependency of graph.get(name) ?? []) visit(dependency, [...path, name]);
      visiting.delete(name);
      visited.add(name);
    };

    for (const name of graph.keys()) visit(name, []);
    expect(visited.size).toBe(graph.size);
  });

  it("keeps core independent and capability runtime dependencies core-only", async () => {
    const manifests = await workspaceManifests();
    const workspaceNames = new Set(manifests.keys());
    const runtimeWorkspaceDependencies = (name: string): string[] => {
      const manifest = manifests.get(name)!;
      return [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ]
        .filter((dependency) => workspaceNames.has(dependency))
        .sort();
    };

    expect(runtimeWorkspaceDependencies("@cjhyy/code-shell-core")).toEqual([]);
    for (const capability of [
      "@cjhyy/code-shell-capability-coding",
      "@cjhyy/code-shell-arena",
      "@cjhyy/code-shell-pet",
    ]) {
      expect(runtimeWorkspaceDependencies(capability)).toEqual(["@cjhyy/code-shell-core"]);
    }
    expect(runtimeWorkspaceDependencies("@cjhyy/code-shell")).toEqual([
      "@cjhyy/code-shell-core",
      "@cjhyy/code-shell-tui",
    ]);
  });

  it("cleans package output before every package-local build", async () => {
    const manifests = await workspaceManifests();
    for (const manifest of manifests.values()) {
      const build = manifest.scripts?.build;
      const clean = manifest.scripts?.clean;
      if (!build || !clean) continue;
      expect(build, `${manifest.name} must clean stale dist before build`).toStartWith(
        "bun run clean &&",
      );
    }
  });

  it("keeps audited package export maps publishable and typed", async () => {
    const manifests = await workspaceManifests();
    for (const definition of AUDITED_RELEASE_PACKAGES) {
      const manifest = manifests.get(definition.name)!;
      expect(validatePublishManifest(definition, manifest)).toEqual([]);
    }
  });

  it("keeps public package provenance, runtime support, and local docs explicit", async () => {
    const manifests = await workspaceManifests();
    for (const definition of PUBLIC_RELEASE_PACKAGES) {
      const manifest = manifests.get(definition.name)!;
      expect(manifest.engines?.node, `${manifest.name} must declare its Node support`).toBe(
        ">=20.10",
      );
      expect(manifest.repository?.type, `${manifest.name} must publish repository metadata`).toBe(
        "git",
      );
      expect(manifest.repository?.url, `${manifest.name} must publish repository metadata`).toBe(
        "git+https://github.com/cjhyy/codeshell.git",
      );

      if (definition.directory === ".") continue;
      expect(
        manifest.repository?.directory,
        `${manifest.name} must link to its workspace directory`,
      ).toBe(definition.directory);
      expect(
        Bun.file(join(repoRoot, definition.directory, "README.md")).size,
        `${manifest.name} must have package-local usage and boundary docs`,
      ).toBeGreaterThan(0);
    }
  });

  it("uses one complete declaration for public release and private version packages", async () => {
    const manifests = await workspaceManifests();
    expect(RELEASE_PACKAGES).toHaveLength(manifests.size);
    expect(new Set(RELEASE_PACKAGES.map((definition) => definition.name))).toEqual(
      new Set(manifests.keys()),
    );

    const actualPublic = [...manifests.values()]
      .filter((manifest) => manifest.private !== true)
      .map((manifest) => manifest.name)
      .sort();
    expect(PUBLIC_RELEASE_PACKAGES.map((definition) => definition.name).sort()).toEqual(
      actualPublic,
    );
    expect(
      PUBLIC_RELEASE_PACKAGES.every((definition) => {
        const manifest = manifests.get(definition.name);
        return manifest?.publishConfig?.access === "public";
      }),
    ).toBe(true);

    expect(PRIVATE_VERSIONED_PACKAGES.map((definition) => definition.name).sort()).toEqual([
      "@cjhyy/code-shell-cdp",
      "@cjhyy/code-shell-desktop",
    ]);
    expect(
      PRIVATE_VERSIONED_PACKAGES.every(
        (definition) => manifests.get(definition.name)?.private === true,
      ),
    ).toBe(true);
    expect(RELEASE_PACKAGES.map(packageManifestPath)).toContain("package.json");
  });

  it("publishes public packages in workspace dependency order", async () => {
    const manifests = await workspaceManifests();
    expect(validatePublicReleaseOrder(manifests)).toEqual([]);
    expect(PUBLIC_RELEASE_PACKAGES.at(-1)?.name).toBe("@cjhyy/code-shell");
    expect(publishCommands("next")).toHaveLength(PUBLIC_RELEASE_PACKAGES.length);
    expect(publishCommands("next").every((command) => command.at(-1) === "next")).toBe(true);
  });

  it("keeps every release version source synchronized", async () => {
    const root = await loadManifest(join(repoRoot, "package.json"));
    expect(collectReleaseVersionErrors(root.version, repoRoot)).toEqual([]);
  });

  it("keeps the workflow on shared release helpers instead of package lists", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    const releaseHelper = readFileSync(join(repoRoot, "scripts", "release.ts"), "utf8");
    expect(workflow).toContain('bun run scripts/verify-release-versions.ts "$TAG"');
    expect(workflow).toContain(
      'bun run scripts/publish-release-packages.ts --tag "$NPM_TAG" --execute',
    );
    expect(workflow).not.toContain("bun publish --cwd packages/");
    expect(releaseHelper).toContain("RELEASE_PACKAGES.map(packageManifestPath)");
    expect(releaseHelper).toContain("bun install --lockfile-only --ignore-scripts");
    expect(releaseHelper).not.toContain("replaceAll(current, target)");
  });

  it("keeps product hosts on focused Coding and Arena entries", () => {
    const hosts = ["desktop", "tui", "server"].flatMap((name) =>
      sourceFiles(join(repoRoot, "packages", name, "src")),
    );
    const allowedCompatibilityImports = new Set([
      join(repoRoot, "packages", "desktop", "src", "main", "settings-service.ts"),
      join(repoRoot, "packages", "tui", "src", "ui", "components", "OnboardingPrompt.tsx"),
    ]);
    const offenders: string[] = [];

    for (const file of hosts) {
      const source = readFileSync(file, "utf8");
      const importsCodingRoot =
        /(?:from\s+|import\s*\()\s*["']@cjhyy\/code-shell-capability-coding["']/.test(source);
      const importsArenaRoot = /(?:from\s+|import\s*\()\s*["']@cjhyy\/code-shell-arena["']/.test(
        source,
      );
      if ((importsCodingRoot || importsArenaRoot) && !allowedCompatibilityImports.has(file)) {
        offenders.push(file.slice(repoRoot.length + 1));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps product hosts on focused Server entries", () => {
    const hosts = ["desktop", "tui", "web", "chat"].flatMap((name) =>
      sourceFiles(join(repoRoot, "packages", name, "src")),
    );
    const offenders = hosts
      .filter((file) =>
        /(?:from\s+|import\s*\()\s*["']@cjhyy\/code-shell-server["']/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => file.slice(repoRoot.length + 1));

    expect(offenders).toEqual([]);
  });
});
