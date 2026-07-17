export interface PublishExportConditions {
  import?: string;
  types?: string;
}

export interface PublishManifest {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: {
    access?: string;
  };
  main?: string;
  types?: string;
  exports?: Record<string, string | PublishExportConditions>;
  bin?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface ReleasePackageDefinition {
  directory: string;
  name: string;
  publish: boolean;
  buildArgs?: readonly string[];
  nonCodeSubpaths?: readonly string[];
  runtimeExcludedSubpaths?: readonly string[];
}

export interface PublishEntry {
  importTarget: string;
  runtimeImport: boolean;
  specifier: string;
  subpath: string;
  typeImport: boolean;
  typesTarget?: string;
}

/**
 * The single release-package declaration.
 *
 * Public entries are deliberately in npm publish order: every public workspace
 * dependency appears before its consumer, and the root meta package is last.
 * Private entries still participate in synchronized version bumps and lockfile
 * verification, but are never packed or published.
 */
export const RELEASE_PACKAGES: readonly ReleasePackageDefinition[] = [
  {
    directory: "packages/core",
    name: "@cjhyy/code-shell-core",
    publish: true,
    runtimeExcludedSubpaths: ["./bin/agent-server-stdio"],
  },
  {
    directory: "packages/pet",
    name: "@cjhyy/code-shell-pet",
    publish: true,
  },
  {
    directory: "packages/arena",
    name: "@cjhyy/code-shell-arena",
    publish: true,
  },
  {
    directory: "packages/coding",
    name: "@cjhyy/code-shell-capability-coding",
    publish: true,
    runtimeExcludedSubpaths: ["./bin/agent-server-stdio"],
  },
  {
    directory: "packages/web",
    name: "@cjhyy/code-shell-web",
    publish: true,
    nonCodeSubpaths: ["./package.json"],
  },
  {
    directory: "packages/server",
    name: "@cjhyy/code-shell-server",
    publish: true,
  },
  {
    directory: "packages/tui",
    name: "@cjhyy/code-shell-tui",
    publish: true,
    runtimeExcludedSubpaths: ["./cli"],
  },
  {
    directory: "packages/chat",
    name: "@cjhyy/code-shell-chat",
    publish: true,
  },
  {
    directory: ".",
    name: "@cjhyy/code-shell",
    publish: true,
    buildArgs: ["run", "scripts/build-meta.ts"],
  },
  {
    directory: "packages/cdp",
    name: "@cjhyy/code-shell-cdp",
    publish: false,
  },
  {
    directory: "packages/desktop",
    name: "@cjhyy/code-shell-desktop",
    publish: false,
  },
];

export const PUBLIC_RELEASE_PACKAGES: readonly ReleasePackageDefinition[] = RELEASE_PACKAGES.filter(
  (definition) => definition.publish,
);

export const PRIVATE_VERSIONED_PACKAGES: readonly ReleasePackageDefinition[] =
  RELEASE_PACKAGES.filter((definition) => !definition.publish);

// Compatibility name for the package smoke/test code introduced with the
// release audit. It intentionally means every public release package now.
export const AUDITED_RELEASE_PACKAGES = PUBLIC_RELEASE_PACKAGES;

export function packageManifestPath(definition: ReleasePackageDefinition): string {
  return definition.directory === "." ? "package.json" : `${definition.directory}/package.json`;
}

export function packageEntrySpecifier(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;
}

export function validatePublicReleaseOrder(
  manifests: ReadonlyMap<string, PublishManifest>,
): string[] {
  const errors: string[] = [];
  const publicNames = new Set(PUBLIC_RELEASE_PACKAGES.map((definition) => definition.name));
  const published = new Set<string>();

  for (const definition of PUBLIC_RELEASE_PACKAGES) {
    const manifest = manifests.get(definition.name);
    if (!manifest) {
      errors.push(`${definition.name}: manifest is missing from release-order validation`);
      continue;
    }
    const runtimeDependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];
    for (const dependency of runtimeDependencies) {
      if (publicNames.has(dependency) && !published.has(dependency)) {
        errors.push(`${definition.name}: public dependency ${dependency} must be published first`);
      }
    }
    published.add(definition.name);
  }

  return errors;
}

export function collectPublishEntries(
  definition: ReleasePackageDefinition,
  manifest: PublishManifest,
): PublishEntry[] {
  const nonCode = new Set(definition.nonCodeSubpaths ?? []);
  const runtimeExcluded = new Set(definition.runtimeExcludedSubpaths ?? []);
  return Object.entries(manifest.exports ?? {}).map(([subpath, target]) => {
    const importTarget = typeof target === "string" ? target : (target.import ?? "");
    return {
      importTarget,
      runtimeImport:
        importTarget.length > 0 && !nonCode.has(subpath) && !runtimeExcluded.has(subpath),
      specifier: packageEntrySpecifier(manifest.name, subpath),
      subpath,
      typeImport: !nonCode.has(subpath),
      typesTarget: typeof target === "string" ? undefined : target.types,
    };
  });
}

export function validatePublishManifest(
  definition: ReleasePackageDefinition,
  manifest: PublishManifest,
): string[] {
  const errors: string[] = [];
  const fail = (message: string): void => {
    errors.push(`${definition.name}: ${message}`);
  };

  if (!definition.publish) {
    fail("private/version-only package cannot be audited as a public package");
  }
  if (manifest.name !== definition.name) {
    fail(`manifest name is ${manifest.name}, expected ${definition.name}`);
  }
  if (!manifest.version) {
    fail("version is missing");
  }
  if (manifest.private === true) {
    fail("public release package must not be private");
  }
  if (manifest.publishConfig?.access !== "public") {
    fail('publishConfig.access must be "public"');
  }
  if (!manifest.files?.includes("dist")) {
    fail('files must include "dist"');
  }

  const exports = manifest.exports ?? {};
  const rootExport = exports["."];
  if (!rootExport) {
    fail("root export is missing");
  }

  const nonCode = new Set(definition.nonCodeSubpaths ?? []);
  for (const [subpath, target] of Object.entries(exports)) {
    if (nonCode.has(subpath)) {
      if (typeof target !== "string" || target !== subpath) {
        fail(`${subpath} non-code export must target itself, received ${JSON.stringify(target)}`);
      }
      continue;
    }

    if (typeof target === "string") {
      if (!/^\.\/dist\/.+\.js$/.test(target)) {
        fail(`${subpath} must target a built JavaScript file, received ${target}`);
      }
      continue;
    }

    const conditions = Object.keys(target).sort();
    if (conditions.join(",") !== "import,types") {
      fail(`${subpath} conditions must be exactly import and types`);
    }
    if (!target.import || !/^\.\/dist\/.+\.js$/.test(target.import)) {
      fail(`${subpath} import target must be a built JavaScript file`);
    }
    if (!target.types || !/^\.\/dist\/.+\.d\.ts$/.test(target.types)) {
      fail(`${subpath} types target must be a built declaration file`);
    }
  }

  if (rootExport && typeof rootExport !== "string") {
    if (manifest.main !== rootExport.import) {
      fail(`main ${manifest.main ?? "<missing>"} does not match root import ${rootExport.import}`);
    }
    if (manifest.types !== rootExport.types) {
      fail(`types ${manifest.types ?? "<missing>"} does not match root types ${rootExport.types}`);
    }
  }

  for (const subpath of nonCode) {
    if (!(subpath in exports)) {
      fail(`non-code export ${subpath} does not match a published export`);
    }
  }

  const runtimeExcluded = new Set(definition.runtimeExcludedSubpaths ?? []);
  for (const subpath of runtimeExcluded) {
    if (!(subpath in exports)) {
      fail(`runtime exclusion ${subpath} does not match a published export`);
    }
  }

  for (const [command, target] of Object.entries(manifest.bin ?? {})) {
    if (!/^\.\/dist\/.+\.js$/.test(target)) {
      fail(`bin ${command} must target a built JavaScript file, received ${target}`);
    }
  }

  return errors;
}
