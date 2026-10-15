import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// The production packages predist actually copies into Desktop's app boundary.
// Bundled packages belong in devDependencies and need no materialized directory.
export const DESKTOP_MATERIALIZED_WORKSPACES = [
  {
    label: "Link",
    packageName: "@cjhyy/code-shell-link",
    relativeDir: "packages/link",
    importSpecifier: "@cjhyy/code-shell-link",
    installProductionDependencies: false,
  },
  {
    label: "core",
    packageName: "@cjhyy/code-shell-core",
    relativeDir: "packages/core",
    importSpecifier: "@cjhyy/code-shell-core",
    installProductionDependencies: true,
  },
  {
    label: "coding",
    packageName: "@cjhyy/code-shell-capability-coding",
    relativeDir: "packages/coding",
    importSpecifier: "@cjhyy/code-shell-capability-coding",
    installProductionDependencies: false,
  },
  {
    label: "Pet",
    packageName: "@cjhyy/code-shell-pet",
    relativeDir: "packages/pet",
    importSpecifier: "@cjhyy/code-shell-pet",
    installProductionDependencies: false,
  },
  {
    label: "Optimization Lab",
    packageName: "@cjhyy/code-shell-capability-optimization-lab",
    relativeDir: "packages/optimization-lab",
    importSpecifier: "@cjhyy/code-shell-capability-optimization-lab/capability",
    installProductionDependencies: true,
  },
] as const;

export interface ProductionWorkspaceManifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export function readRepositoryWorkspaceNames(repoRoot: string): ReadonlySet<string> {
  const packagesRoot = resolve(repoRoot, "packages");
  const names = new Set<string>();
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(packagesRoot, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ProductionWorkspaceManifest;
    names.add(manifest.name);
  }
  return names;
}

export function assertMaterializedWorkspaceDependencies(
  manifest: ProductionWorkspaceManifest,
  workspaceNames: ReadonlySet<string>,
): void {
  const materialized = new Set<string>(
    DESKTOP_MATERIALIZED_WORKSPACES.map(({ packageName }) => packageName),
  );
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    // Bun may resolve a same-name workspace even when its dependency range uses
    // semver, so the scheme alone cannot identify all out-of-app symlink risks.
    if ((version.startsWith("workspace:") || workspaceNames.has(name)) && !materialized.has(name)) {
      throw new Error(
        `${manifest.name}: production workspace dependency ${name} is not materialized by predist; ` +
          "bundle it as a devDependency or add it to DESKTOP_MATERIALIZED_WORKSPACES",
      );
    }
  }
}
