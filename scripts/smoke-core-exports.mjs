import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import * as publicApi from "@cjhyy/code-shell-core";
import * as internalApi from "@cjhyy/code-shell-core/internal";

const coreDistDir = resolve(fileURLToPath(new URL("../packages/core/dist/", import.meta.url)));

for (const specifier of ["@cjhyy/code-shell-core", "@cjhyy/code-shell-core/internal"]) {
  const resolvedModule = fileURLToPath(import.meta.resolve(specifier));
  const relativeToDist = relative(coreDistDir, resolvedModule);
  assert.equal(
    relativeToDist !== "" && !relativeToDist.startsWith(`..${sep}`) && relativeToDist !== "..",
    true,
    `${specifier} must resolve inside packages/core/dist, resolved to ${resolvedModule}`,
  );
}

assert.equal(typeof publicApi.Engine, "function");
assert.equal(typeof publicApi.createServer, "function");

// Host-only runtime symbols that must NOT be reachable from the public root
// barrel. Mirrors `hostOnlySamples` in packages/core/src/index.exports.test.ts —
// keep the two lists in sync; this one checks the BUILT dist, that one the source.
//
// This replaces the pre-0.8 rule that walked every `/internal` export and
// required it to ALSO exist on public. That rule predated the deliberate
// export-surface convergence (eb3bd752, "BREAKING CHANGE (0.8)"), which moved
// installer/marketplace/onboarding/updater off the public root. The two
// contracts were mutually exclusive, so this smoke failed on the first
// internal-only value (`BUILTIN_CATALOG`) even though the separation was
// correct and the four source-level contract tests passed.
const hostOnlySamples = [
  "sliceAnsi",
  "getGraphemeSegmenter",
  "logForDebugging",
  "getTheme",
  "rotateLogs",
  "recordUIEvent",
  "notificationQueue",
  "cronScheduler",
  "asyncAgentRegistry",
  "backgroundShellManager",
  "ENV_DENY_REGEX",
  "transcribe",
  "getMergedCatalog",
  "createInProcessClient",
  "fetchModelList",
  "PROVIDER_KINDS",
  "listSourceDefinitions",
  "LOCAL_FILES_SOURCE_ID",
  "resolveUploadTarget",
  "activateWorkspaceProfile",
  "CapabilityService",
  "computeEffectiveDisabledLists",
  "installPluginFromPath",
  "installPlugin",
  "previewLocalPlugin",
  "uninstallPluginByName",
  "addMarketplace",
  "parseMarketplaceInput",
  "resolveApiKey",
  "detectEnvKeys",
  "getCurrentVersion",
  "checkForUpdate",
  "BUILTIN_CATALOG",
];

for (const exportName of hostOnlySamples) {
  assert.equal(
    exportName in internalApi,
    true,
    `${exportName} must be exported from @cjhyy/code-shell-core/internal`,
  );
  assert.equal(
    exportName in publicApi,
    false,
    `${exportName} is host-only and must NOT be re-exported from the public root`,
  );
}

// Symbols intentionally shared by BOTH entries must be the same binding, not a
// duplicated module instance — two copies of a singleton (notificationQueue,
// SettingsManager, …) would silently split host state.
const sharedIdentityContract = [
  "SessionManager",
  "SettingsManager",
  "codeShellHome",
  "logger",
  "BUILTIN_TOOLS",
  "BUILTIN_AGENT_PRESETS",
];

for (const exportName of sharedIdentityContract) {
  if (!(exportName in internalApi) || !(exportName in publicApi)) continue;
  assert.equal(
    internalApi[exportName],
    publicApi[exportName],
    `${exportName} must have the same public/internal identity`,
  );
}

assert.equal("Engine" in internalApi, false);
assert.equal("Arena" in internalApi, false);

// The complete type-only surface of /internal, pinned so an accidental addition
// or removal is a deliberate edit. Refreshed for 0.8: the 24 host-assembly types
// (plugin installer/preview, npm/marketplace, onboarding, updater, digital-human
// catalog, tool-registry harness) moved to /internal with their runtime
// counterparts, but this list was never updated — nothing was removed, so the
// separation itself was intact; only the pin had drifted.
const expectedInternalTypeExports = [
  "ApprovalRequest",
  "ApprovalResult",
  "ApprovalScope",
  "AsyncAgentEntry",
  "AutomationHandle",
  "BackgroundAgentCompletedEvent",
  "BashLineKind",
  "BgShell",
  "BgShellStatus",
  "CachedModel",
  "Capability",
  "CatalogEntry",
  "ClassifiedBashLine",
  "CreateJobOptions",
  "CronExecutionOutcome",
  "CronJob",
  "CronJobLifecycleEvent",
  "CronPermissionLevel",
  "CronRunRequest",
  "CronRunResult",
  "CronRunner",
  "CronTemplateSource",
  "DigitalHumanCatalogSourceEntry",
  "DigitalHumanCatalogTeam",
  "FakeToolContextOptions",
  "FetchResult",
  "HumanRepoListEntry",
  "ImageGenerateRequest",
  "ImageGenerateResult",
  "ImageProvider",
  "ImageProviderCreds",
  "InstallPluginFromPathOptions",
  "LocalPluginAutomationTemplatePreview",
  "LocalPluginHookPreview",
  "LocalPluginInterfacePreview",
  "LocalPluginMcpPreview",
  "LocalPluginPreview",
  "LocalPluginPreviewWarning",
  "LocalPluginPreviewWarningKind",
  "NotificationItem",
  "NpmPluginFetch",
  "NpmPluginInstallOptions",
  "OnboardingResult",
  "ParsedCron",
  "ParsedSource",
  "PluginListRow",
  "ProtocolModelEntry",
  "ProviderConfig",
  "ProviderKindName",
  "ReasoningControl",
  "ReasoningSetting",
  "ResolvedNpmPlugin",
  "ResolvedTranscribeProvider",
  "RunSubmitter",
  "RunWriteJobInput",
  "RunWriteJobResult",
  "SandboxConfig",
  "StartAutomationDeps",
  "SystemTheme",
  "TaskInfo",
  "Theme",
  "ThemeName",
  "ThemeSetting",
  "ToolRegistryHarness",
  "ToolRegistryHarnessOptions",
  "TranscribeCreds",
  "TranscribeDescription",
  "TranscribeRequest",
  "TranscribeResult",
  "UpdateCheck",
  "UpdateInfo",
  "UpdateJobPatch",
  "UpdateResult",
  "WriteJobGitOps",
  "WritePolicy",
];

const internalDeclaration = resolve(coreDistDir, "index.internal.d.ts");
const declarationProgram = ts.createProgram([internalDeclaration], {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
});
const declarationSource = declarationProgram.getSourceFile(internalDeclaration);
assert.ok(declarationSource, "dist/index.internal.d.ts must be emitted");

const declarationChecker = declarationProgram.getTypeChecker();
const declarationSymbol = declarationChecker.getSymbolAtLocation(declarationSource);
assert.ok(declarationSymbol, "dist/index.internal.d.ts must be an external module");

const actualInternalTypeOnlyExports = declarationChecker
  .getExportsOfModule(declarationSymbol)
  .filter((symbol) => {
    const target =
      symbol.flags & ts.SymbolFlags.Alias ? declarationChecker.getAliasedSymbol(symbol) : symbol;
    return (target.flags & ts.SymbolFlags.Value) === 0;
  })
  .map((symbol) => symbol.name)
  .sort();

assert.deepEqual(
  actualInternalTypeOnlyExports,
  [...expectedInternalTypeExports].sort(),
  "dist/index.internal.d.ts type-only exports must match the complete expected list",
);

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const consumerDir = mkdtempSync(resolve(repoRoot, ".core-exports-consumer-"));

try {
  const consumerPath = resolve(consumerDir, "consumer.ts");
  const importedInternalTypes = expectedInternalTypeExports.join(",\n  ");
  const referencedInternalTypes = expectedInternalTypeExports.join(",\n  ");
  writeFileSync(
    consumerPath,
    `import type { EngineConfig } from "@cjhyy/code-shell-core";
import type {
  ${importedInternalTypes}
} from "@cjhyy/code-shell-core/internal";

type PublicAndInternalTypes = [
  EngineConfig,
  ${referencedInternalTypes}
];

export type { PublicAndInternalTypes };
`,
  );

  const tscPath = resolve(repoRoot, "node_modules/typescript/bin/tsc");
  const typecheck = spawnSync(
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
      "--traceResolution",
      consumerPath,
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );

  assert.equal(typecheck.status, 0, typecheck.stdout + typecheck.stderr);
  const resolutionTrace = (typecheck.stdout + typecheck.stderr).split(sep).join("/");
  assert.match(
    resolutionTrace,
    /packages\/core\/dist\/index\.d\.ts/,
    "public types must resolve to packages/core/dist/index.d.ts",
  );
  assert.match(
    resolutionTrace,
    /packages\/core\/dist\/index\.internal\.d\.ts/,
    "internal types must resolve to packages/core/dist/index.internal.d.ts",
  );
} finally {
  rmSync(consumerDir, { recursive: true, force: true });
}

console.log(
  `core public/internal dist export smoke passed (${Object.keys(internalApi).length} runtime, ${expectedInternalTypeExports.length} internal type exports)`,
);
