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

// I1 retains root compatibility aliases while establishing the new subpath.
for (const exportName of Object.keys(internalApi)) {
  assert.equal(exportName in publicApi, true, `${exportName} must remain available from public`);
  assert.equal(
    internalApi[exportName],
    publicApi[exportName],
    `${exportName} must have the same public/internal identity`,
  );
}

assert.equal("Engine" in internalApi, false);
assert.equal("Arena" in internalApi, false);

const expectedInternalTypeExports = [
  "AttributedCounter",
  "ChannelEntry",
  "BashLineKind",
  "ClassifiedBashLine",
  "Theme",
  "ThemeName",
  "ThemeSetting",
  "SystemTheme",
  "SandboxConfig",
  "NotificationItem",
  "BackgroundAgentCompletedEvent",
  "StartAutomationDeps",
  "AutomationHandle",
  "CronJob",
  "CronPermissionLevel",
  "CreateJobOptions",
  "UpdateJobPatch",
  "CronRunner",
  "CronRunRequest",
  "CronRunResult",
  "RunSubmitter",
  "ParsedCron",
  "WritePolicy",
  "WriteJobGitOps",
  "RunWriteJobInput",
  "RunWriteJobResult",
  "AsyncAgentEntry",
  "BgShell",
  "BgShellStatus",
  "ImageProvider",
  "ImageProviderCreds",
  "ImageGenerateRequest",
  "ImageGenerateResult",
  "TranscribeCreds",
  "TranscribeRequest",
  "TranscribeResult",
  "ResolvedTranscribeProvider",
  "TranscribeDescription",
  "CatalogEntry",
  "ProtocolModelEntry",
  "OutputSink",
  "CachedModel",
  "FetchResult",
  "ProviderKindName",
  "Capability",
  "ReasoningControl",
  "ReasoningSetting",
  "ProviderConfig",
  "ApprovalRequest",
  "ApprovalResult",
  "ApprovalScope",
  "TaskInfo",
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
