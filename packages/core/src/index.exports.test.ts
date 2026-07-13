import { describe, expect, it } from "bun:test";

import type {
  ProtocolModelEntry as _InternalProtocolModelEntry,
  TaskInfo as _InternalTaskInfo,
} from "@cjhyy/code-shell-core/internal";
import * as publicApi from "./index.js";

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
    "resolveWritePolicy",
    "wrapUntrustedInput",
    "runWriteJobInWorktree",
    "pathWithCommonBins",
    "probeCli",
    "probeClaudeCli",
    "probeCodexCli",
    "CC_COST_GUARD_PROMPT",
    "claudeAdapter",
    "codexAdapter",
    "runWithLines",
    "detectCodexImageInput",
    "runAgentOnce",
    "encodeCwd",
    "DEFAULT_DISCOVER_LIMIT",
    "DEFAULT_DISCOVER_SINCE_MS",
    "selectRecentStats",
    "discoverSessions",
    "countSessions",
    "discoverCodexSessions",
    "countCodexSessions",
    "buildJudgePrompt",
    "parseJudgeResponse",
    "judgeContinuation",
    "parseRecentHistory",
    "parseClaudeTranscriptLine",
    "readRecentHistory",
    "readCodexRecentHistory",
    "parseCodexRecentHistory",
    "parseCodexTranscriptLine",
    "findCodexRolloutFile",
    "checkQuota",
    "formatQuota",
    "resolveQuotaCredentials",
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
} as const;

const expectedRuntimeExports = Object.values(expectedRuntimeExportsByPartition).flat();

describe("core public/internal export contract", () => {
  it("keeps the stable public API without host process state", () => {
    expect(publicApi.Engine).toBeDefined();
    expect(publicApi.createServer).toBeDefined();

    expect(publicApi).not.toHaveProperty("getSessionId");
    expect(publicApi).not.toHaveProperty("markScrollActivity");
    expect(publicApi).not.toHaveProperty("Arena");
    expect(publicApi).not.toHaveProperty("formatArenaResult");
  });

  it("exposes the complete host-only runtime surface from the source internal entry", async () => {
    const internalApi = await import("./index.internal.js");
    const internalExports = internalApi as Record<string, unknown>;
    const publicExports = publicApi as Record<string, unknown>;

    expect(new Set(expectedRuntimeExports).size).toBe(expectedRuntimeExports.length);
    expect(Object.keys(internalApi).sort()).toEqual([...expectedRuntimeExports].sort());

    for (const [partition, exportNames] of Object.entries(expectedRuntimeExportsByPartition)) {
      for (const exportName of exportNames) {
        expect(publicExports, `${partition}.${exportName} must remain public`).toHaveProperty(
          exportName,
        );
        expect(internalExports[exportName], `${partition}.${exportName} identity`).toBe(
          publicExports[exportName],
        );
      }
    }

    // /internal is a focused host barrel rather than a duplicate of index.ts.
    expect(internalApi).not.toHaveProperty("Engine");
    expect(internalApi).not.toHaveProperty("Arena");
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
