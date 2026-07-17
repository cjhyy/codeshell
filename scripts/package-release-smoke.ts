#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  AUDITED_RELEASE_PACKAGES,
  collectPublishEntries,
  validatePublishManifest,
  type PublishEntry,
  type PublishManifest,
  type ReleasePackageDefinition,
} from "./package-release-audit-config";

type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies";
type SmokeMode = "dry-run" | "full" | "list";

interface WorkspaceManifest extends PublishManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface AuditedPackageRecord {
  definition: ReleasePackageDefinition;
  entries: PublishEntry[];
  manifest: WorkspaceManifest;
  sourceDirectory: string;
}

interface PackedPackageRecord extends AuditedPackageRecord {
  extractedDirectory: string;
  packedManifest: WorkspaceManifest;
  tarballPath: string;
}

const DEPENDENCY_SECTIONS: readonly DependencySection[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const CONSUMER_DEPENDENCY_SECTIONS: readonly DependencySection[] = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function parseReleaseSmokeArgs(args: readonly string[]): SmokeMode {
  if (args.length === 0) return "full";
  if (args.length === 1 && args[0] === "--list") return "list";
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  throw new Error("usage: bun run test:package-release [--list | --dry-run]");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function packageLabel(record: AuditedPackageRecord): string {
  return `${record.manifest.name}@${record.manifest.version}`;
}

function commandOutput(result: SpawnSyncReturns<string>): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function runCommand(
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  console.log(`→ ${label}`);
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`[${label}] could not start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`[${label}] failed with exit ${result.status}\n${commandOutput(result)}`);
  }
  console.log(`✓ ${label}`);
  return result;
}

function loadAuditedPackages(): AuditedPackageRecord[] {
  const records = AUDITED_RELEASE_PACKAGES.map((definition) => {
    const sourceDirectory = join(REPO_ROOT, definition.directory);
    const manifest = readJson<WorkspaceManifest>(join(sourceDirectory, "package.json"));
    return {
      definition,
      entries: collectPublishEntries(definition, manifest),
      manifest,
      sourceDirectory,
    };
  });
  const errors = records.flatMap(({ definition, manifest }) =>
    validatePublishManifest(definition, manifest),
  );
  if (errors.length > 0) {
    throw new Error(
      `publish manifest audit failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }
  return records;
}

function printPackageList(records: readonly AuditedPackageRecord[]): void {
  for (const record of records) {
    console.log(`${packageLabel(record)}  ${record.definition.directory}`);
    for (const entry of record.entries) {
      const modes = !entry.typeImport
        ? "packed asset"
        : entry.runtimeImport
          ? "types + runtime"
          : "types only (side-effect entry)";
      console.log(`  ${entry.subpath.padEnd(26)} ${entry.specifier}  [${modes}]`);
    }
  }
}

function loadWorkspaceVersions(): Map<string, string> {
  const versions = new Map<string, string>();
  const manifestPaths = [
    join(REPO_ROOT, "package.json"),
    ...readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(REPO_ROOT, "packages", entry.name, "package.json"))
      .filter(existsSync),
  ];
  for (const path of manifestPaths) {
    const manifest = readJson<WorkspaceManifest>(path);
    versions.set(manifest.name, manifest.version);
  }
  return versions;
}

function buildPackages(records: readonly AuditedPackageRecord[]): void {
  for (const record of records) {
    runCommand(
      `clean build ${packageLabel(record)}`,
      "bun",
      record.definition.buildArgs ?? ["run", "build"],
      record.sourceDirectory,
    );
  }
}

function assertPackedWorkspaceDependencies(
  record: AuditedPackageRecord,
  packedManifest: WorkspaceManifest,
  workspaceVersions: ReadonlyMap<string, string>,
): void {
  for (const section of DEPENDENCY_SECTIONS) {
    const sourceDependencies = record.manifest[section] ?? {};
    const packedDependencies = packedManifest[section] ?? {};

    for (const [dependency, packedRange] of Object.entries(packedDependencies)) {
      if (packedRange.startsWith("workspace:")) {
        throw new Error(
          `[${packageLabel(record)}] ${section}.${dependency} leaked ${packedRange} into the tarball`,
        );
      }
    }

    for (const [dependency, sourceRange] of Object.entries(sourceDependencies)) {
      if (!sourceRange.startsWith("workspace:")) continue;
      const expectedVersion = workspaceVersions.get(dependency);
      if (!expectedVersion) {
        throw new Error(
          `[${packageLabel(record)}] cannot verify workspace dependency ${dependency}: version not found`,
        );
      }
      const packedRange = packedDependencies[dependency];
      if (packedRange !== expectedVersion) {
        throw new Error(
          `[${packageLabel(record)}] ${section}.${dependency} packed as ${packedRange ?? "<missing>"}, expected ${expectedVersion}`,
        );
      }
    }
  }
}

function assertPackedExportTargets(record: PackedPackageRecord): void {
  for (const entry of record.entries) {
    for (const [kind, target] of [
      ["import", entry.importTarget],
      ["types", entry.typesTarget],
    ] as const) {
      if (!target) continue;
      const targetPath = resolve(record.extractedDirectory, target);
      const relativeTarget = relative(record.extractedDirectory, targetPath);
      const escapesPackage =
        relativeTarget === ".." ||
        relativeTarget.startsWith(`..${sep}`) ||
        isAbsolute(relativeTarget);
      if (escapesPackage || !existsSync(targetPath)) {
        throw new Error(
          `[${packageLabel(record)} ${entry.subpath}] packed ${kind} target is missing: ${target}`,
        );
      }
    }
  }

  for (const [command, target] of Object.entries(record.packedManifest.bin ?? {})) {
    const targetPath = resolve(record.extractedDirectory, target);
    if (!existsSync(targetPath)) {
      throw new Error(`[${packageLabel(record)}] packed bin ${command} is missing: ${target}`);
    }
  }
}

function packAndExtractPackages(
  records: readonly AuditedPackageRecord[],
  temporaryRoot: string,
): PackedPackageRecord[] {
  const tarballDirectory = join(temporaryRoot, "tarballs");
  const extractedRoot = join(temporaryRoot, "consumer", "node_modules", "@cjhyy");
  const workspaceVersions = loadWorkspaceVersions();
  mkdirSync(tarballDirectory, { recursive: true });
  mkdirSync(extractedRoot, { recursive: true });

  return records.map((record) => {
    const packResult = runCommand(
      `pack ${packageLabel(record)}`,
      "bun",
      ["pm", "pack", "--ignore-scripts", "--destination", tarballDirectory, "--quiet"],
      record.sourceDirectory,
    );
    const tarballOutput = packResult.stdout.trim().split(/\r?\n/).at(-1);
    if (!tarballOutput) {
      throw new Error(`[${packageLabel(record)}] bun pm pack did not report a tarball path`);
    }
    const tarballPath = isAbsolute(tarballOutput)
      ? tarballOutput
      : join(tarballDirectory, basename(tarballOutput));
    if (!existsSync(tarballPath)) {
      throw new Error(`[${packageLabel(record)}] bun pm pack did not create ${tarballPath}`);
    }

    const packageDirectoryName = record.manifest.name.slice("@cjhyy/".length);
    const extractedDirectory = join(extractedRoot, packageDirectoryName);
    mkdirSync(extractedDirectory, { recursive: true });
    runCommand(
      `extract ${packageLabel(record)}`,
      "tar",
      ["-xzf", tarballPath, "-C", extractedDirectory, "--strip-components=1"],
      REPO_ROOT,
    );

    const packedManifest = readJson<WorkspaceManifest>(join(extractedDirectory, "package.json"));
    assertPackedWorkspaceDependencies(record, packedManifest, workspaceVersions);
    const packedRecord = {
      ...record,
      extractedDirectory,
      packedManifest,
      tarballPath,
    };
    assertPackedExportTargets(packedRecord);
    return packedRecord;
  });
}

function linkModule(source: string, target: string): void {
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  const realSource = realpathSync(source);
  symlinkSync(realSource, target, process.platform === "win32" ? "junction" : undefined);
}

function linkInstalledDependencies(
  records: readonly PackedPackageRecord[],
  consumerDirectory: string,
): void {
  const consumerNodeModules = join(consumerDirectory, "node_modules");
  const packedNames = new Set(records.map((record) => record.manifest.name));

  for (const record of records) {
    const declaredDependencies = new Set(
      CONSUMER_DEPENDENCY_SECTIONS.flatMap((section) =>
        Object.keys(record.packedManifest[section] ?? {}),
      ),
    );
    for (const dependency of declaredDependencies) {
      if (packedNames.has(dependency)) continue;
      const sourceCandidates = [
        join(record.sourceDirectory, "node_modules", dependency),
        join(REPO_ROOT, "node_modules", dependency),
      ];
      const source = sourceCandidates.find(existsSync);
      if (!source) {
        throw new Error(
          `[${packageLabel(record)}] installed dependency ${dependency} was not found`,
        );
      }
      linkModule(source, join(consumerNodeModules, dependency));
    }
  }

  // The consumer harness itself is a Node TypeScript project. This is the only
  // dev type linked deliberately. Package-local devDependencies are excluded,
  // so exported declarations cannot accidentally rely on unpublished types.
  linkModule(
    join(REPO_ROOT, "node_modules", "@types", "node"),
    join(consumerNodeModules, "@types", "node"),
  );
}

function typeConsumerSource(entries: readonly PublishEntry[]): string {
  const typedEntries = entries.filter((entry) => entry.typeImport);
  const imports = typedEntries
    .map(
      (entry, index) => `import type * as Entry${index} from ${JSON.stringify(entry.specifier)};`,
    )
    .join("\n");
  const uses = typedEntries.map((_entry, index) => `typeof Entry${index}`).join(",\n  ");
  return `${imports}

export type PublishedEntryNamespaces = [
  ${uses}
];
`;
}

function runTypecheck(
  packageName: string,
  entries: readonly PublishEntry[],
  consumerDirectory: string,
): SpawnSyncReturns<string> {
  const safeName = packageName.replace(/[^a-z0-9]+/gi, "-");
  const consumerPath = join(consumerDirectory, `types-${safeName}.ts`);
  writeFileSync(consumerPath, typeConsumerSource(entries));
  const tscPath = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  return spawnSync(
    process.execPath,
    [
      tscPath,
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--strict",
      "--skipLibCheck",
      "false",
      "--types",
      "node",
      "--noErrorTruncation",
      consumerPath,
    ],
    {
      cwd: consumerDirectory,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

function assertStrictDeclarations(
  records: readonly PackedPackageRecord[],
  consumerDirectory: string,
): void {
  for (const record of records) {
    const typedEntries = record.entries.filter((entry) => entry.typeImport);
    const label = `strict NodeNext declarations ${packageLabel(record)}`;
    console.log(`→ ${label}`);
    const result = runTypecheck(record.manifest.name, typedEntries, consumerDirectory);
    if (result.error) {
      throw new Error(`[${label}] could not start TypeScript: ${result.error.message}`);
    }
    if (result.status === 0) {
      console.log(`✓ ${label} (${typedEntries.length} entries)`);
      continue;
    }

    const entryFailures = typedEntries.flatMap((entry) => {
      const entryResult = runTypecheck(
        `${record.manifest.name}-${entry.subpath}`,
        [entry],
        consumerDirectory,
      );
      return entryResult.status === 0
        ? []
        : [
            `${record.manifest.name} ${entry.subpath} (${entry.specifier})\n${commandOutput(entryResult)}`,
          ];
    });
    throw new Error(
      `[${label}] failed; isolated failing entries:\n\n${entryFailures.join("\n\n")}`,
    );
  }
}

function assertRuntimeImports(
  records: readonly PackedPackageRecord[],
  consumerDirectory: string,
): void {
  const runtimeEntries = records.flatMap((record) =>
    record.entries
      .filter((entry) => entry.runtimeImport)
      .map((entry) => ({
        packageName: record.manifest.name,
        specifier: entry.specifier,
        subpath: entry.subpath,
      })),
  );
  const runtimeScript = join(consumerDirectory, "runtime-imports.mjs");
  writeFileSync(
    runtimeScript,
    `const entries = ${JSON.stringify(runtimeEntries, null, 2)};
for (const entry of entries) {
  try {
    await import(entry.specifier);
    console.log(\`✓ runtime \${entry.packageName} \${entry.subpath}\`);
  } catch (error) {
    console.error(\`runtime import failed: \${entry.packageName} \${entry.subpath} (\${entry.specifier})\`);
    throw error;
  }
}
`,
  );
  const home = join(consumerDirectory, "home");
  mkdirSync(home);
  runCommand(
    `runtime imports (${runtimeEntries.length} entries)`,
    "node",
    [runtimeScript],
    consumerDirectory,
    {
      ...process.env,
      CODE_SHELL_HOME: join(home, ".code-shell"),
      HOME: home,
      USERPROFILE: home,
    },
  );
}

function runFullSmoke(records: readonly AuditedPackageRecord[]): void {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "codeshell-package-release-"));
  try {
    buildPackages(records);
    const packedRecords = packAndExtractPackages(records, temporaryRoot);
    const consumerDirectory = join(temporaryRoot, "consumer");
    writeFileSync(join(consumerDirectory, "package.json"), '{"private":true,"type":"module"}\n');
    linkInstalledDependencies(packedRecords, consumerDirectory);
    assertStrictDeclarations(packedRecords, consumerDirectory);
    assertRuntimeImports(packedRecords, consumerDirectory);
    console.log(
      `\nPackage release smoke passed: ${packedRecords.length} tarballs, ${packedRecords.reduce(
        (count, record) => count + record.entries.filter((entry) => entry.typeImport).length,
        0,
      )} typed entries.`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
  const mode = parseReleaseSmokeArgs(args);
  const records = loadAuditedPackages();
  if (mode === "list") {
    printPackageList(records);
    return;
  }
  if (mode === "dry-run") {
    printPackageList(records);
    console.log(
      "\nDry run passed: manifests and entry configuration are valid; no build or tarball was created.",
    );
    return;
  }
  runFullSmoke(records);
}

const invokedAsMain =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedAsMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
