import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

import {
  AUDITED_RELEASE_PACKAGES,
  PRIVATE_VERSIONED_PACKAGES,
  PUBLIC_RELEASE_PACKAGES,
  RELEASE_PACKAGES,
  collectPublishEntries,
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

const workspaceDependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const workspaceName = (suffix: string): string =>
  suffix === "." ? "@cjhyy/code-shell" : `@cjhyy/code-shell-${suffix}`;
const expectedWorkspaceDependencies: Record<
  string,
  Partial<Record<(typeof workspaceDependencyFields)[number], string[]>>
> = {
  ".": { dependencies: ["core", "tui"] },
  link: {},
  chat: {},
  "browser-devtools": {},
  core: { dependencies: ["link"] },
  "capability-coding": { dependencies: ["core"] },
  pet: { dependencies: ["core"] },
  "capability-optimization-lab": { dependencies: ["core"] },
  host: { dependencies: ["core"] },
  web: { dependencies: ["core", "link"] },
  server: { dependencies: ["core", "link", "host", "web", "capability-coding"] },
  tui: { dependencies: ["core", "capability-coding", "server"] },
  desktop: {
    dependencies: ["core", "capability-coding", "pet", "capability-optimization-lab"],
    devDependencies: ["browser-devtools", "chat", "host", "link", "server", "web"],
  },
};

function packageImportSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

describe("workspace package boundaries", () => {
  it("pins every workspace dependency in its declared manifest field", async () => {
    const manifests = await workspaceManifests();
    expect([...manifests.keys()].sort()).toEqual(
      Object.keys(expectedWorkspaceDependencies).map(workspaceName).sort(),
    );
    for (const [suffix, expected] of Object.entries(expectedWorkspaceDependencies)) {
      const manifest = manifests.get(workspaceName(suffix))!;
      for (const field of workspaceDependencyFields) {
        const actual = Object.keys(manifest[field] ?? {})
          .filter((name) => /^@cjhyy\/code-shell(?:$|-)/.test(name))
          .sort();
        expect(actual, `${manifest.name} ${field}`).toEqual(
          (expected[field] ?? []).map(workspaceName).sort(),
        );
      }
    }
  });

  it("declares every workspace import used by production source, including types", async () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(repoRoot, "packages", entry.name);
      const manifest = await loadManifest(join(directory, "package.json"));
      const declared = new Set([manifest.name, ...dependencyNames(manifest)]);
      const roots = [
        join(directory, "src"),
        ...(entry.name === "web" ? [join(directory, "app")] : []),
      ];
      for (const file of roots.filter(existsSync).flatMap(sourceFiles)) {
        if (
          /\.fixture\.[cm]?[jt]sx?$/.test(file) ||
          /[\\/](?:__fixtures__|test-utils)[\\/]/.test(file)
        )
          continue;
        for (const specifier of packageImportSpecifiers(file)) {
          const name = specifier.match(/^(@cjhyy\/code-shell(?:-[^/]+)?)(?:\/|$)/)?.[1];
          if (name && !declared.has(name))
            offenders.push(`${relative(repoRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

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

  it("keeps Core limited to the dependency-free Link contract and capabilities Core-only", async () => {
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

    expect(runtimeWorkspaceDependencies("@cjhyy/code-shell-core")).toEqual([
      "@cjhyy/code-shell-link",
    ]);
    const link = manifests.get("@cjhyy/code-shell-link")!;
    expect(dependencyNames(link)).toEqual([]);
    expect(Object.keys(link.exports ?? {})).toEqual(["."]);
    for (const capability of [
      "@cjhyy/code-shell-capability-coding",
      "@cjhyy/code-shell-pet",
      "@cjhyy/code-shell-capability-optimization-lab",
    ]) {
      expect(runtimeWorkspaceDependencies(capability)).toEqual(["@cjhyy/code-shell-core"]);
    }
    expect(runtimeWorkspaceDependencies("@cjhyy/code-shell")).toEqual([
      "@cjhyy/code-shell-core",
      "@cjhyy/code-shell-tui",
    ]);
  });

  it("keeps Host runtime and declaration imports independent of other hosts and capabilities", async () => {
    const manifest = await loadManifest(join(repoRoot, "packages", "host", "package.json"));
    expect(dependencyNames(manifest)).toEqual(["@cjhyy/code-shell-core"]);
    expect(Object.keys(manifest.exports ?? {})).toEqual([".", "./session-files"]);

    const hostSourceRoot = join(repoRoot, "packages", "host", "src");
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    const offenders: string[] = [];
    for (const file of sourceFiles(hostSourceRoot)) {
      const source = readFileSync(file, "utf8");
      // Includes type-only imports, export-from and import("...") declaration
      // references, so re-exporting another package cannot hide behind types.
      const references = source.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)["']([^"']+)["']/g,
      );
      for (const [, specifier] of references) {
        if (specifier.startsWith(".")) {
          const target = relative(hostSourceRoot, resolve(dirname(file), specifier));
          if (target === ".." || target.startsWith(`..${sep}`)) {
            offenders.push(`${relative(repoRoot, file)} -> ${specifier}`);
          }
        } else if (
          specifier !== "@cjhyy/code-shell-core" &&
          !specifier.startsWith("@cjhyy/code-shell-core/") &&
          !builtins.has(specifier)
        ) {
          offenders.push(`${relative(repoRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("audits Host runtime and declarations after Core and before downstream hosts", async () => {
    const name = "@cjhyy/code-shell-host";
    const definition = AUDITED_RELEASE_PACKAGES.find((definition) => definition.name === name)!;
    expect(definition?.directory).toBe("packages/host");
    const manifest = await loadManifest(join(repoRoot, "packages", "host", "package.json"));
    expect(collectPublishEntries(definition, manifest)).toEqual([
      {
        importTarget: "./dist/index.js",
        runtimeImport: true,
        specifier: name,
        subpath: ".",
        typeImport: true,
        typesTarget: "./dist/index.d.ts",
      },
      {
        importTarget: "./dist/index.session-files.js",
        runtimeImport: true,
        specifier: `${name}/session-files`,
        subpath: "./session-files",
        typeImport: true,
        typesTarget: "./dist/index.session-files.d.ts",
      },
    ]);
    const order = PUBLIC_RELEASE_PACKAGES.map((definition) => definition.name);
    expect(order.indexOf(name)).toBeGreaterThan(order.indexOf("@cjhyy/code-shell-core"));
    expect(order.indexOf(name)).toBeLessThan(order.indexOf("@cjhyy/code-shell-server"));
  });

  it("keeps the storage Host entry narrow in source aliases and the production server bundle", async () => {
    const config = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8"));
    expect(config.compilerOptions.paths["@cjhyy/code-shell-host/session-files"]).toEqual([
      "packages/host/src/index.session-files.ts",
    ]);
    // Use Desktop's declared bundler dependency, as its production build does.
    const desktopRequire = createRequire(join(repoRoot, "packages/desktop/package.json"));
    const { build, stop } = await import(pathToFileURL(desktopRequire.resolve("esbuild")).href);
    // esbuild's JS API keeps one `esbuild --service` child (and its two stdio
    // descriptors) alive for the rest of the process until stop() is called.
    // Every later suite in this shared Bun process would otherwise inherit it.
    const result = await build({
      entryPoints: [join(repoRoot, "packages/server/src/index.storage.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      metafile: true,
      external: ["@cjhyy/code-shell-core", "@cjhyy/code-shell-core/*"],
    }).finally(() => stop());
    const hostInputs = Object.keys(result.metafile!.inputs).filter((file) =>
      file.includes("packages/host/"),
    );
    expect(hostInputs.sort()).toEqual([
      "packages/host/dist/index.session-files.js",
      "packages/host/dist/services/session-files.js",
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
      "@cjhyy/code-shell-browser-devtools",
      "@cjhyy/code-shell-capability-optimization-lab",
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
    expect(workflow).toContain("bun run packages/desktop/scripts/build-workspace-dependencies.ts");
    expect(workflow).toMatch(
      /npm-publish:[\s\S]*?needs: \[verify-version, package-release-smoke, package\]/,
    );
    expect(workflow).not.toContain("bun publish --cwd packages/");
    expect(releaseHelper).toContain("RELEASE_PACKAGES.map(packageManifestPath)");
    expect(releaseHelper).toContain("bun install --lockfile-only --ignore-scripts");
    expect(releaseHelper).not.toContain("replaceAll(current, target)");
  });

  it.each(["dependencies", "optionalDependencies", "peerDependencies"] as const)(
    "rejects an unpublished workspace in a public package's %s",
    async (field) => {
      const all = await workspaceManifests();
      // The publisher loads only public manifests, so private workspaces are
      // deliberately absent from this map.
      const manifests = new Map(PUBLIC_RELEASE_PACKAGES.map(({ name }) => [name, all.get(name)!]));
      const tui = manifests.get("@cjhyy/code-shell-tui")!;
      manifests.set(tui.name, {
        ...tui,
        [field]: { ...tui[field], "@cjhyy/code-shell-browser-devtools": "workspace:*" },
      });
      expect(validatePublicReleaseOrder(manifests)).toContain(
        "@cjhyy/code-shell-tui: runtime dependency @cjhyy/code-shell-browser-devtools is a private workspace and will not be published",
      );
    },
  );

  it("keeps product hosts on focused Coding entries", () => {
    const hosts = ["desktop", "tui", "server"].flatMap((name) =>
      sourceFiles(join(repoRoot, "packages", name, "src")),
    );
    const allowedCompatibilityImports = new Set([
      join(repoRoot, "packages", "desktop", "src", "main", "settings-service.ts"),
    ]);
    const offenders: string[] = [];

    for (const file of hosts) {
      const source = readFileSync(file, "utf8");
      const importsCodingRoot =
        /(?:from\s+|import\s*\()\s*["']@cjhyy\/code-shell-capability-coding["']/.test(source);
      if (importsCodingRoot && !allowedCompatibilityImports.has(file)) {
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

  it("keeps Server runtime imports on React-free Web entries", () => {
    const offenders: string[] = [];
    const isWebRoot = (node: ts.Node | undefined): boolean =>
      !!node && ts.isStringLiteralLike(node) && node.text === "@cjhyy/code-shell-web";
    for (const file of sourceFiles(join(repoRoot, "packages/server/src"))) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
      const visit = (node: ts.Node): void => {
        let runtimeRoot = false;
        if (ts.isImportDeclaration(node) && isWebRoot(node.moduleSpecifier)) {
          const clause = node.importClause;
          runtimeRoot =
            !clause ||
            (!clause.isTypeOnly &&
              (!!clause.name ||
                !clause.namedBindings ||
                ts.isNamespaceImport(clause.namedBindings) ||
                clause.namedBindings.elements.length === 0 ||
                clause.namedBindings.elements.some((entry) => !entry.isTypeOnly)));
        } else if (ts.isExportDeclaration(node) && isWebRoot(node.moduleSpecifier)) {
          runtimeRoot =
            !node.isTypeOnly &&
            (!node.exportClause ||
              ts.isNamespaceExport(node.exportClause) ||
              node.exportClause.elements.length === 0 ||
              node.exportClause.elements.some((entry) => !entry.isTypeOnly));
        } else if (ts.isCallExpression(node) && isWebRoot(node.arguments[0])) {
          runtimeRoot =
            node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require");
        } else if (
          ts.isImportEqualsDeclaration(node) &&
          !node.isTypeOnly &&
          ts.isExternalModuleReference(node.moduleReference)
        ) {
          runtimeRoot = isWebRoot(node.moduleReference.expression);
        }
        if (runtimeRoot) offenders.push(relative(repoRoot, file));
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });
});
