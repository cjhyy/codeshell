import { describe, expect, it } from "bun:test";

import type {
  ProtocolModelEntry as _InternalProtocolModelEntry,
  TaskInfo as _InternalTaskInfo,
} from "@cjhyy/code-shell-core/internal";
import type {
  BuildSourcesContextSummaryInput as _BuildSourcesContextSummaryInput,
  ConnectorAdapter as _ConnectorAdapter,
  EffectiveDisabledLists as _EffectiveDisabledLists,
  EffectiveSourceAccess as _EffectiveSourceAccess,
  ResolveActiveWorkspaceProfileInput as _ResolveActiveWorkspaceProfileInput,
  WorkspaceProfile as _WorkspaceProfile,
  WorkspaceProfileSubtree as _WorkspaceProfileSubtree,
} from "./index.js";
import * as publicApi from "./index.js";

// The full pinned runtime surface of the /internal host entry. /internal is the
// ONLY entry for these host-facing exports — index.ts no longer re-exports them
// (export-surface convergence, 2026-07-15). Keep this list in sync with
// index.internal.ts. Host-assembly surfaces (installer/marketplace/onboarding/
// updater) moved here in 0.8.
const expectedRuntimeExportsByPartition = {
  utils: [
    "getGraphemeSegmenter",
    "firstGrapheme",
    "lastGrapheme",
    "getWordSegmenter",
    "getRelativeTimeFormat",
    "getTimeZone",
    "getSystemLocaleLanguage",
    "env",
    "sliceAnsi",
    "execFileNoThrow",
    "findExecutable",
    "resolveExecutable",
    "setGitPathOverride",
    "resolveGit",
    "isGitAvailable",
    "resolveGitPath",
    "gte",
    "lock",
    "lockSync",
    "unlock",
    "check",
    "logForDebugging",
    "isEnvTruthy",
    "isEnvDefinedFalsy",
    "getClaudeConfigHomeDir",
    "isBareMode",
    "parseEnvVars",
    "shouldMaintainProjectWorkingDir",
    "getAWSRegion",
    "getDefaultVertexRegion",
    "getVertexRegionForModel",
    "startCapturingEarlyInput",
    "stopCapturingEarlyInput",
    "consumeEarlyInput",
    "hasEarlyInput",
    "seedEarlyInput",
    "isCapturingEarlyInput",
    "formatBytes",
    "formatToolArgs",
    "singleLine",
    "MAX_LINE_WIDTH",
    "TOOL_DOT_COLORS",
    "classifyBashLines",
    "formatDuration",
    "formatTokens",
    "getTheme",
    "resolveThemeSetting",
  ],
  logging: ["rotateLogs", "recordUIEvent"],
  toolSystemAndHostServices: [
    "getInteractiveApprovalBackend",
    "defaultSandboxConfig",
    "buildNotificationMessage",
    "buildNotificationSummary",
    "notificationQueue",
    "agentNotificationBus",
    "notificationItemToStreamEvent",
    "startAutomation",
    "CronScheduler",
    "cronScheduler",
    "CronStore",
    "defaultCronStorePath",
    "bindCronToEngine",
    "bindCronToRunManager",
    "isCronExpression",
    "parseCronExpression",
    "nextCronTime",
    "validateSchedule",
    "resolveWritePolicy",
    "wrapUntrustedInput",
    "runWriteJobInWorktree",
    "createOffBackend",
    "createFakeToolContext",
    "createToolRegistryHarness",
    "fileCache",
    "validateToolArgs",
    "asyncAgentRegistry",
    "backgroundShellManager",
    "BackgroundShellManager",
    "ENV_DENY_REGEX",
    "ENV_ALLOWLIST",
    "getImageProvider",
    "DEFAULT_IMAGE_MODEL",
    "transcribe",
    "resolveTranscribeProvider",
    "isTranscribeAvailable",
    "describeTranscribe",
    "BUILTIN_CATALOG",
    "getMergedCatalog",
    "loadUserCatalog",
    "userCatalogPath",
    "findCatalogEntry",
    "saveCatalogEntry",
    "deleteUserCatalogEntry",
    "catalogEntryOrigins",
  ],
  protocolExtensions: ["createInProcessClient"],
  llmHostExtensions: [
    "defaultCacheDir",
    "fetchModelList",
    "sanitizeApiKey",
    "hasNonAsciiPrintable",
    "PROVIDER_KINDS",
    "capabilitiesFor",
    "reasoningControlFor",
    "REASONING_EFFORTS",
  ],
  extendedHostTypes: [],
  sourcesProfilesCapabilityControl: [
    "sourceCatalogPath",
    "listSourceDefinitions",
    "readSourceDefinition",
    "saveSourceDefinition",
    "deleteSourceDefinition",
    "registerConnectorAdapter",
    "connectorAdapterFor",
    "mockAdapter",
    "LOCAL_FILES_SOURCE_ID",
    "uploadsDir",
    "localFilesSourceFor",
    "resolveUploadTarget",
    "localFilesAdapter",
    "listLocalFiles",
    "createMcpResourceAdapter",
    "defaultMcpResourceAdapter",
    "listBindings",
    "bindSource",
    "unbindSource",
    "resolveEffectiveSourceAccess",
    "defaultCredentialStatus",
    "buildSourcesContextSummary",
    "deleteWorkspaceProfile",
    "listWorkspaceProfiles",
    "readWorkspaceProfile",
    "saveWorkspaceProfile",
    "workspaceProfileDir",
    "workspaceProfilesRoot",
    "activateWorkspaceProfile",
    "deactivateWorkspaceProfile",
    "profileOverridesFromDefinition",
    "resolveActiveWorkspaceProfile",
    "workspaceProfilePresetFor",
    "CapabilityService",
    "CapabilityNotFoundError",
    "projectBuiltin",
    "projectMcp",
    "projectSkills",
    "projectPlugins",
    "computeEffectiveDisabledLists",
  ],
  hostAssembly: [
    "installPluginFromPath",
    "installPluginFromSource",
    "installPluginFromNpm",
    "resolveNpmPlugin",
    "downloadVerifiedNpmTarball",
    "NPM_PUBLIC_REGISTRY",
    "MAX_NPM_METADATA_BYTES",
    "extractNpmTar",
    "gunzipNpmTarball",
    "MAX_NPM_TARBALL_BYTES",
    "MAX_NPM_TAR_EXTRACTED_BYTES",
    "MAX_NPM_TAR_FILE_BYTES",
    "MAX_NPM_TAR_ENTRIES",
    "MAX_NPM_TAR_PATH_BYTES",
    "MAX_NPM_TAR_DEPTH",
    "installLocalPlugin",
    "installPluginFromArchive",
    "installReviewedLocalPlugin",
    "previewLocalPlugin",
    "LocalPluginReviewChangedError",
    "parseSource",
    "parseNpmPluginSource",
    "detectPluginFormat",
    "uninstallPluginByName",
    "listInstalledPlugins",
    "updatePluginByName",
    "checkPluginUpdate",
    "installPlugin",
    "uninstallPlugin",
    "listInstalled",
    "addMarketplace",
    "refreshMarketplace",
    "removeMarketplace",
    "listMarketplaces",
    "loadMarketplace",
    "parseMarketplaceInput",
    "deriveMarketplaceName",
    "hasApiKey",
    "resolveApiKey",
    "appendOnboardingResult",
    "detectEnvKeys",
    "getCurrentVersion",
    "checkForUpdate",
    "scheduleAutoInstallOnExit",
    "getUpdateAvailable",
    "getAutoUpdateDisabledReason",
  ],
} as const;

const expectedRuntimeExports = Object.values(expectedRuntimeExportsByPartition).flat();

// Host-only symbols that must NOT leak back onto the public root barrel.
// (Representative sample across the removed @internal partitions.)
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
] as const;

// Runtime members of the /extension capability contract (coding/arena imports).
const extensionRuntimeContract = [
  "registerCapability",
  "SessionManager",
  "SettingsManager",
  "codeShellHome",
  "notificationQueue",
  "backgroundJobRegistry",
  "safeSpawnShell",
  "buildSandboxEnv",
  "resolveExecutable",
  "resolveGit",
  "invalidateFileCache",
  "BUILTIN_AGENT_PRESETS",
  "BUILTIN_TOOLS",
  "derivePresetExposure",
  "logger",
] as const;

// Stable workspace data-source schema/constants surface. Host runtime belongs
// to /internal; renderer/preload consumers only need these values and types.
const sourcePublicRuntimeContract = [
  "SOURCE_ID_RE",
  "SOURCE_KINDS",
  "SourceDefinitionSchema",
  "WorkspaceSourceBindingSchema",
] as const;

describe("core public/internal export contract", () => {
  it("keeps the stable public API without host process state", () => {
    expect(publicApi.Engine).toBeDefined();
    expect(publicApi.createServer).toBeDefined();
    expect(publicApi.WorkspaceProfileSchema).toBeDefined();
    expect(publicApi.WORKSPACE_PROFILE_NAME_RE).toBeDefined();
    for (const name of sourcePublicRuntimeContract) {
      expect(publicApi[name], `public root must export ${name}`).toBeDefined();
    }

    expect(publicApi).not.toHaveProperty("getSessionId");
    expect(publicApi).not.toHaveProperty("markScrollActivity");
    expect(publicApi).not.toHaveProperty("Arena");
    expect(publicApi).not.toHaveProperty("formatArenaResult");

    // Host-only surface has moved to /internal (or /extension); the public
    // barrel must not re-grow it.
    for (const name of hostOnlySamples) {
      expect(publicApi, `${name} must stay off the public root barrel`).not.toHaveProperty(name);
    }
  });

  it("exposes the complete host-only runtime surface from the source internal entry", async () => {
    const internalApi = await import("./index.internal.js");
    const internalExports = internalApi as Record<string, unknown>;
    const publicExports = publicApi as Record<string, unknown>;

    expect(new Set(expectedRuntimeExports).size).toBe(expectedRuntimeExports.length);
    expect(Object.keys(internalApi).sort()).toEqual([...expectedRuntimeExports].sort());

    // Where a symbol is intentionally shared with the public barrel (process
    // singletons and helpers that SDK users legitimately need too), the two
    // entries must resolve to the same reference.
    for (const exportName of expectedRuntimeExports) {
      if (exportName in publicExports) {
        expect(internalExports[exportName], `${exportName} identity across entries`).toBe(
          publicExports[exportName],
        );
      }
    }

    // /internal is a focused host barrel rather than a duplicate of index.ts.
    expect(internalApi).not.toHaveProperty("Engine");
    expect(internalApi).not.toHaveProperty("Arena");
  });

  it("exposes the capability contract from the extension entry with singleton identity", async () => {
    const extensionApi = (await import("./index.extension.js")) as Record<string, unknown>;
    const internalApi = (await import("./index.internal.js")) as Record<string, unknown>;

    for (const name of extensionRuntimeContract) {
      expect(extensionApi[name], `/extension must export ${name}`).toBeDefined();
    }

    // Process singletons shared by hosts (via /internal) and capability
    // packages (via /extension) must be the same instance.
    expect(extensionApi.notificationQueue).toBe(internalApi.notificationQueue);

    // The extension entry stays narrow: no Engine, no host UI utilities.
    expect(extensionApi).not.toHaveProperty("Engine");
    expect(extensionApi).not.toHaveProperty("sliceAnsi");
  });

  it("declares the internal package subpath and an exact source alias", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const rootTsconfig = await Bun.file(new URL("../../../tsconfig.json", import.meta.url)).json();

    expect(packageJson.exports["./internal"]).toEqual({
      types: "./dist/index.internal.d.ts",
      import: "./dist/index.internal.js",
    });
    expect(rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-core/internal"]).toEqual([
      "packages/core/src/index.internal.ts",
    ]);
    expect(packageJson.exports["./extension"]).toEqual({
      types: "./dist/index.extension.d.ts",
      import: "./dist/index.extension.js",
    });
    expect(rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-core/extension"]).toEqual([
      "packages/core/src/index.extension.ts",
    ]);
  });
});
