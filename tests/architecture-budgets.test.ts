import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

function source(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

function lines(path: string): number {
  return source(path).split("\n").length - 1;
}

function matches(path: string, pattern: RegExp): number {
  return [...source(path).matchAll(pattern)].length;
}

function ipcSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name).split("\\").join("/");
    if (entry.isDirectory()) return ipcSourceFiles(path);
    return entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !/\.(test|fixture|d)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

function countIpc(
  root: string,
  defaultPattern: RegExp,
  specialPatterns: Record<string, RegExp>,
): number {
  return ipcSourceFiles(root).reduce(
    (total, path) => total + matches(path, specialPatterns[path] ?? defaultPattern),
    0,
  );
}

// Source files are capped, not pinned. Any file may change freely below its
// cap; a file that would exceed it must be split into modules instead of
// raising the number. Caps are round ceilings, never measured line counts.
const DEFAULT_MAX_LINES = 1_500;

// Files that already exceeded DEFAULT_MAX_LINES on 2026-11-09, each capped at
// the next multiple of 500 with at least 100 lines of room. These caps may only
// go down. When a split brings a file under DEFAULT_MAX_LINES, delete its entry.
// Do not add entries for new files: split them instead.
const LEGACY_MAX_LINES: Record<string, number> = {
  "packages/desktop/src/main/index.ts": 5_000,
  "packages/core/src/engine/engine.ts": 5_000,
  "packages/core/src/protocol/server.ts": 4_500,
  "packages/desktop/src/main/panel-app-bridge.ts": 3_500,
  "packages/web/src/hooks/useRemoteApp.ts": 3_500,
  "packages/desktop/src/main/pet/pet-dispatch-service.ts": 2_500,
  "packages/desktop/src/renderer/digital-humans/DigitalHumansView.tsx": 3_500,
  "packages/desktop/src/preload/types.d.ts": 3_500,
  "packages/desktop/src/renderer/App.tsx": 3_500,
  "packages/desktop/src/renderer/ChatView.tsx": 3_000,
  "packages/desktop/src/main/agent-bridge.ts": 3_000,
  "packages/tui/src/native-ts/yoga-layout/index.ts": 3_000,
  "packages/core/src/engine/turn-loop.ts": 3_000,
  "packages/desktop/src/renderer/i18n/ns/settings.ts": 3_000,
  "packages/desktop/src/renderer/i18n/ns/extensions.ts": 3_000,
  "packages/server/src/panels/runtime.ts": 3_000,
  "packages/core/src/session/session-manager.ts": 2_500,
  "packages/desktop/src/main/external-runtime-service.ts": 2_500,
  "packages/tui/src/ui/App.tsx": 2_500,
  "packages/server/src/links/service.ts": 2_500,
  "packages/server/src/mobile-remote/room-manager.ts": 2_500,
  "packages/desktop/src/renderer/settings/AdvancedSections.tsx": 2_500,
  "packages/core/src/tool-system/permission.ts": 2_500,
  "packages/tui/src/render/ink.tsx": 2_500,
  "packages/core/src/tool-system/mcp-manager.ts": 2_500,
  "packages/desktop/src/renderer/settings/McpSection.tsx": 2_500,
  "packages/web/app/Workbench.tsx": 2_000,
  "packages/desktop/src/renderer/credentials/LinkTab.tsx": 2_000,
  "packages/desktop/src/preload/index.ts": 2_000,
  "packages/coding/src/tools/drive-agent.ts": 2_000,
  "packages/server/src/serve/headless-server.ts": 2_000,
  "packages/desktop/src/renderer/Sidebar.tsx": 2_000,
  "packages/desktop/src/main/im-gateway-service.ts": 2_000,
  "packages/core/src/tool-system/builtin/agent.ts": 2_000,
  "packages/core/src/llm/providers/openai.ts": 2_000,
  "packages/desktop/src/renderer/app/useRunController.ts": 2_000,
  "packages/core/src/session/output-journal.ts": 2_000,
  "packages/desktop/src/main/im-gateway-control-server.ts": 2_000,
};

const SKIPPED_DIRS = new Set(["node_modules", "dist", "__tests__", "test", "tests", "fixtures"]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;

function sourceFiles(): string[] {
  const roots = readdirSync("packages")
    .map((pkg) => join("packages", pkg, "src"))
    .concat("packages/web/app")
    .filter((root) => existsSync(root));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
        files.push(path.split("\\").join("/"));
      }
    }
  };
  roots.forEach(walk);
  return files.sort();
}

function moduleMockFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist" ? [] : moduleMockFiles(path);
    }
    return entry.isFile() &&
      /\.[cm]?[jt]sx?$/.test(entry.name) &&
      /\bmock\.module\(/.test(source(path))
      ? [path]
      : [];
  });
}

// L0 may depend on L1–L7; lower-level directories must not import upward.
// Root entry files are outside this directory-layer guard. Keep builtin tools
// distinct from the generic tool-system infrastructure that they build on.
const CORE_LAYERS: readonly (readonly string[])[] = [
  ["cli", "product"],
  ["run", "protocol"],
  ["engine"],
  ["tool-system/builtin", "composition"],
  [
    "automation",
    "skills",
    "plugins",
    "panel-apps",
    "links",
    "sources",
    "operations",
    "services",
    "prompt",
    "preset",
    "hooks",
    "context",
    "capability-control",
    "profile",
    "themes",
    "speech",
    "stt",
  ],
  ["tool-system"],
  [
    "session",
    "credentials",
    "settings",
    "model-catalog",
    "llm",
    "model-request-boundary",
    "model-traces",
    "cost-ledger",
    "goal",
    "workspace",
  ],
  ["utils", "runtime", "logging", "data", "agent", "remote", "testing", "capabilities"],
];

// Measured on fcd8406d5. These exceptions may only shrink: removing the import
// must remove its allowance in the same change. New dependencies need a lower
// layer, not another exception. Type-only dependencies do not consume a slot.
const UPWARD_ALLOWLIST = new Set([
  "credentials/access.ts -> links",
  "credentials/access.ts -> services",
  "hooks/goal-stop-hook.ts -> tool-system/builtin",
  "links/github-issue-batch.ts -> engine",
  "links/operation-reader.ts -> engine",
  "preset/index.ts -> tool-system/builtin",
  "prompt/composer.ts -> tool-system/builtin",
  "runtime/background-shell.ts -> tool-system/builtin",
  "session/background-continuation.ts -> tool-system/builtin",
  "skills/isolated-instruction-run.ts -> protocol",
  "tool-system/builtin/configure-model-connection.ts -> engine",
  "tool-system/dynamic-tool-defs.ts -> tool-system/builtin",
  "tool-system/executor.ts -> tool-system/builtin",
  "tool-system/path-policy.ts -> plugins",
  "tool-system/registry.ts -> tool-system/builtin",
  "tool-system/session-tool-host.ts -> engine",
  "tool-system/session-tool-host.ts -> hooks",
  "tool-system/session-tool-policy.ts -> capability-control",
]);

const SAME_LAYER_CYCLES = new Set(["hooks <-> plugins", "preset <-> prompt"]);

const CORE_GRAPH_EXCLUDED_DIRS = new Set(["__fixtures__", "fixtures", "__tests__"]);

function coreSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return CORE_GRAPH_EXCLUDED_DIRS.has(entry.name) ? [] : coreSourceFiles(path);
    }
    return entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec|d)\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

function coreNode(path: string): string | undefined {
  const parts = path.split("/");
  if (parts.length < 2 || parts[0] === "..") return undefined;
  return parts[0] === "tool-system" && parts[1] === "builtin" ? "tool-system/builtin" : parts[0];
}

function valueModuleSpecifiers(file: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    let module: ts.Expression | undefined;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyNamedTypes =
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((item) => item.isTypeOnly);
      if (!clause?.isTypeOnly && (clause?.name || !onlyNamedTypes)) module = node.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      module = node.moduleReference.expression;
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      const onlyNamedTypes =
        clause &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((item) => item.isTypeOnly);
      if (!node.isTypeOnly && !onlyNamedTypes) module = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      module = node.arguments[0];
    }
    if (module && ts.isStringLiteralLike(module)) specifiers.push(module.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

function coreValueGraph() {
  const root = resolve("packages/core/src");
  const config = ts.readConfigFile(resolve("tsconfig.json"), ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, resolve("."));
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n"),
    );
  }
  const cache = ts.createModuleResolutionCache(resolve("."), (path) => path, parsed.options);
  const nodes = new Set(
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !CORE_GRAPH_EXCLUDED_DIRS.has(entry.name))
      .map((entry) => entry.name),
  );
  const edges: Array<{ file: string; from: string; to: string }> = [];
  for (const file of coreSourceFiles(root)) {
    const path = relative(root, file).split("\\").join("/");
    const from = coreNode(path);
    if (!from) continue;
    nodes.add(from);
    const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
    for (const specifier of valueModuleSpecifiers(ast)) {
      const target = ts.resolveModuleName(
        specifier,
        file,
        parsed.options,
        ts.sys,
        cache,
      ).resolvedModule;
      if (!target) continue;
      const to = coreNode(relative(root, target.resolvedFileName).split("\\").join("/"));
      if (!to || from === to) continue;
      nodes.add(to);
      edges.push({ file: path, from, to });
    }
  }
  return { nodes, edges };
}

describe("source file line caps", () => {
  test("no source file grows past its cap; split it into modules instead", () => {
    const over = sourceFiles()
      .map((path) => ({
        path,
        count: lines(path),
        cap: LEGACY_MAX_LINES[path] ?? DEFAULT_MAX_LINES,
      }))
      .filter(({ count, cap }) => count > cap)
      .map(({ path, count, cap }) => `${path}: ${count} lines > cap ${cap}`);
    expect(over, "Split these files into modules; do not raise the cap.").toEqual([]);
  });

  test("legacy caps are removed once a file is split under the default", () => {
    const stale = Object.keys(LEGACY_MAX_LINES)
      .filter((path) => !existsSync(path) || lines(path) <= DEFAULT_MAX_LINES)
      .map((path) => `${path}: delete its LEGACY_MAX_LINES entry`);
    expect(stale).toEqual([]);
  });
});

describe("architecture growth budgets", () => {
  test("module-mocked files cannot spread across the test suite", () => {
    // After Arena removal: 65 TypeScript files plus seven JavaScript fixtures.
    // Include fixtures and JS variants so moving a mock cannot hide from this cap.
    const files = ["packages", "tests"].flatMap(moduleMockFiles);
    expect(
      files.length,
      "改用依赖注入 (dependency injection); do not add files that use module mocks.",
    ).toBeLessThanOrEqual(72);
  });

  test("Core value imports keep layers and shrink known exceptions", () => {
    const { nodes, edges } = coreValueGraph();
    const layers = new Map(
      CORE_LAYERS.flatMap((nodes, layer) => nodes.map((node) => [node, layer] as const)),
    );
    expect(
      [...nodes].filter((node) => !layers.has(node)).sort(),
      "Assign every new Core directory to CORE_LAYERS before adding dependencies.",
    ).toEqual([]);
    const upward = new Set(
      edges
        .filter(({ from, to }) => layers.get(from)! > layers.get(to)!)
        .map(({ file, to }) => `${file} -> ${to}`),
    );
    expect(
      [...upward].filter((edge) => !UPWARD_ALLOWLIST.has(edge)).sort(),
      "Move new upward value imports to a lower layer; do not expand UPWARD_ALLOWLIST.",
    ).toEqual([]);
    expect(
      [...UPWARD_ALLOWLIST].filter((edge) => !upward.has(edge)).sort(),
      "Remove resolved upward imports from UPWARD_ALLOWLIST in the same change.",
    ).toEqual([]);
    const sameLayer = edges.filter(({ from, to }) => layers.get(from) === layers.get(to));
    const directed = new Set(sameLayer.map(({ from, to }) => `${from} -> ${to}`));
    const mutual = new Set(
      sameLayer
        .filter(({ from, to }) => directed.has(`${to} -> ${from}`))
        .map(({ from, to }) => [from, to].sort().join(" <-> ")),
    );
    expect(
      [...mutual].filter((pair) => !SAME_LAYER_CYCLES.has(pair)).sort(),
      "Do not introduce new mutually dependent Core directories in the same layer.",
    ).toEqual([]);
    expect(
      [...SAME_LAYER_CYCLES].filter((pair) => !mutual.has(pair)).sort(),
      "Remove resolved mutual dependencies from SAME_LAYER_CYCLES in the same change.",
    ).toEqual([]);
  });

  test("IPC routes and preload invokes cannot grow silently", () => {
    // Count extracted registrations too: moving a route cannot hide API growth.
    // New explicit project-package, remote-Link and Cloud-window operations are
    // part of this feature's reviewed transport contract, total 295 routes.
    // +1 authenticated, owner-scoped cancelRestore route releases abandoned
    // version reviews. Count the extracted version registrar in the same budget.
    // +3 reviewed device registration/status/forget operations, no credential read.
    // +2 main-frame-only Desktop file metadata/preview operations. These read an
    // explicitly selected file without granting access to its parent directory.
    // Count the full session transcript registrar, including its two previously
    // extracted routes, and three reviewed Task Center list/get/act routes.
    // The reviewed additions are five Link challenge operations, four Lab
    // operations and one usage-history query. Count every registration, including
    // the extracted modules, with no allowance for future routes.
    // Optional accounts add eight reviewed main-frame-owned operations: status,
    // capabilities, login, register, github, linkGitHub, cancelSignIn and logout. Their results
    // expose only public account state; access/refresh tokens remain in Main.
    // Include the extracted registrar and raise only this contract baseline by eight.
    // Capabilities is the v0.9.34 anonymous, origin-bounded service discovery route;
    // it exposes only registration/GitHub availability, never account credentials.
    // Count all five explicit collection operations in the extracted registrar.
    // Managed runtime discovery retains its two existing routes in an extracted registrar.
    // The registrar loops over eight fixed method entries, so count entries, not the loop.
    // Two linked-file source routes: snapshot and add. Project resolution and
    // Link authorization stay in Main; extraction must not hide them.
    // Three owner-scoped DriveAgent task routes: list, cancel and the user's
    // explicit mark-ended for a task no live process reports.
    // rooms:create and ccRoom:openSession, moved here unchanged in number so
    // both pass the Host room permission-mode authority.
    // Nine local-only Lab routes: eight existing operations plus P2 native
    // adoption. Exact body/scope review and post-dialog revalidation remain
    // in this owner-scoped registrar; ordinary RPC cannot approve adoption.
    // Count the two existing native manual-review routes and the new
    // fixed-read reconciliation route; extraction must not hide them.
    // Exactly two Native batch routes: bounded options and manual approval.
    // Main alone issues the private Run nonce; extraction cannot hide IPC growth.
    // Mimi's single presence owner: get/set/preview/retry plus the two legacy
    // pet:widget-visible(-get) routes moved here from index.ts.
    // The 2026-11-09 index.ts split moved 176 existing routes into these
    // registrars without adding any; count each so the move hides nothing.
    // 2026-11: scan every production file instead of a manually maintained list.
    // The legacy 48-file selection still counts 390; the other 82 routes already
    // existed but were not counted. This baseline grants no new routes.
    expect(
      countIpc("packages/desktop/src/main", /ipcMain\.handle\(/g, {
        "packages/desktop/src/main/account-device-ipc.ts": /^    [a-z]+: \(/gm,
        "packages/desktop/src/main/model-trace-ipc.ts": /handle\("modelTraces:/g,
        "packages/desktop/src/main/task-inbox/task-inbox-ipc.ts": /handle\("taskInbox:/g,
        "packages/desktop/src/main/optimization-lab-ipc.ts": /handle\("optimizationLab:/g,
        "packages/desktop/src/main/operation-resolution-ipc.ts":
          /handle\(\s*"operationResolution:/g,
        "packages/desktop/src/main/operation-batch-ipc.ts": /handle\("operationBatch:/g,
      }),
      // +1 read-only, bounded Session output-journal page route. Its file/owner
      // validation and recovery algorithm stay in Core and the extracted adapters.
      // +2 metadata-only Profile preview and revision-checked adoption routes.
      // +3 preview/cancel/reviewed-save operations, without installation authority.
      // +2 project-memory copy preview/commit operations, bound to a main-frame review.
      // +1 main-frame-owned Account profile read/update operation, bound to the
      // signed-in origin/UUID. Only public names cross IPC; credentials stay in Main.
      // +5 main-frame-owned Computer Use setup operations: status, enable,
      // permission request, fixed System Settings links, and restart.
      // +2 main-frame-owned Native batch options/start operations.
      // +2 linked-file source snapshot/add operations; no file content crosses IPC.
      // The integrated baseline contains 356 routes (the previous ceiling missed one).
      // +4 local model trace list/detail/config read/update routes, restricted to application main frames.
      // +1 metadata-only session grouping route shares the same fixed store and caller guard.
      // +1 review:preparePrompt; prompt assembly and Git reads stay in the review service.
      // +1 externalRuntime:yieldGoal; the owner check and Goal state stay in the service.
      // +3 backgroundWork list/cancelJob/markInterrupted; ownership checks stay in Core.
      // +2 main-frame-owned Mimi companion setting and preview routes.
      // +1 computerUse:input (stop/resume/force-stop); the gate itself lives in
      // the CUA proxy, so this route only flips host-owned state.
      // The merged tree counts 367: the previous ceiling carried two spare routes.
      // +2 Main-frame-only history recovery plan/apply routes; caller and paths remain Host-owned.
      // Measured after merging main (2026-10-29): main counts 368, this branch adds 3.
      // +1 panel-apps:bindingsForProjects batches binding reads so each package is verified once.
      // +4 main-frame-owned Mimi presence routes (get/set/preview/retry). The two
      // legacy widget-visibility routes moved, not added; every Mimi entry now goes
      // through one owner, so docked and moving can never be shown together.
      // +1 explicit account resume; construction/status remain side-effect free.
      // +8 main-frame-owned computer operations: list/projects/connect/resume/send/stop/approve/close.
      // Main retains credentials and pins every operation to its owner/Host/project/Session.
      // +3 main-frame-only account operations: fixed registration page, public
      // feature snapshot and bounded refresh. No credential-read route is exposed.
      // +2 main-frame-owned account operations: browser sign-in and fixed account
      // management pages. PKCE, session custody and origin checks remain in Main.
    ).toBeLessThanOrEqual(472);
    expect(matches("packages/desktop/src/main/account-device-ipc.ts", /^    [a-z]+: \(/gm)).toBe(8);
    expect(
      matches("packages/desktop/src/main/session-output-history-ipc.ts", /ipcMain\.handle\(/g),
    ).toBe(2);
    // Include all nine extracted Lab invokes and the five generic Link
    // challenge invokes plus usage history. Main-only routes remain counted
    // above even when no renderer adapter exists; do not equate the totals.
    // Count the same eight reviewed optional-account invokes: status, capabilities,
    // login, register, github, linkGitHub, cancelSignIn and logout. No token-read API
    // exists; this increases the invoke contract by exactly eight, not line budgets.
    // Count each fixed helper call plus send's raw delivery DTO invoke.
    // The legacy 16-file selectors counted 371. Counting both invoke receivers
    // also finds two existing accountFeatures calls that its old ipc-only regex
    // missed (373 on that selection). The other 108 invokes were outside the
    // list, so the full measured baseline is 481, not the review's initial 479.
    expect(
      countIpc("packages/desktop/src/preload", /\b(?:ipcRenderer|ipc)\.invoke\(/g, {
        "packages/desktop/src/preload/account-device-api.ts": /\binvoke(?:Raw)?\("/g,
      }),
      // Five reviewed collection invokes. Native file paths never arrive as renderer arguments.
      // +2 memory-copy invokes; commit carries only the reviewed token and project.
      // +1 typed cloudAccount:profile invoke mirrors the single reviewed Main
      // read/update route above; no credential-read or additional route is added.
      // +5 typed Computer Use setup invokes; no raw native command surface.
      // +2 typed Native batch adapters return no private nonce.
      // +2 typed linked-file snapshot/add invokes mirror the two Main routes above.
      // The integrated baseline contains 349 invokes; tracing adds four fixed
      // list/detail/config read/update invokes, without renderer filesystem access.
      // +1 session grouping invoke mirrors the single guarded Main route above.
      // +3 Mimi companion setting, preview and chat-focus invokes.
      // +1 computerUse:input mirrors the single stop/resume/force-stop Main route.
      // +2 typed history recovery plan/apply invokes mirror the reviewed Main routes.
      // +9 mirrors explicit account resume and the eight bounded computer operations above.
      // +3 exact adapters for registration, feature snapshot and refresh above.
      // Browser sign-in and fixed account-management navigation add two typed
      // adapters within the existing ceiling; neither exposes credentials.
    ).toBeLessThanOrEqual(481);
    expect(
      matches("packages/desktop/src/preload/account-device-api.ts", /\binvoke(?:Raw)?\("/g),
    ).toBe(8);
  });

  test("published entry points cannot silently expand their compatibility surface", () => {
    const exportBudgets: Record<string, number> = {
      // Re-tightened after the composition cutover deleted the legacy
      // registerCapability/registerPreset/registerSection export surface.
      // The remote Link client is an intentional public SDK capability consumed
      // by standalone Hosts; tokens stay in their credential authority.
      // +2 LifetimeScope runtime/type statements for standalone SDK module
      // owners; +2 Local OAuth and reviewed remote-provider adapters for external
      // Hosts; +2 UsageLedger runtime/type statements for durable SDK accounting.
      // Profile sourceAccess extends the existing source export statement.
      // Parser executables and cache invalidation remain Host-only below.
      // +1 type-only signer contract lets an SDK Host supply custody without
      // exposing the key store, worker IPC or mutable default signer authority.
      // +1 collection manifest schema/types for standalone Hosts and type-only Desktop UI.
      // +1 type-only preset routing policy/rule contract; no runtime or permission authority.
      // +1 CONTRACTS: read-only contract version table reported by initialize and /health; no host state.
      // Explicit history recovery adds one public type-only contract export.
      "packages/core/src/index.ts": 135,
      // +3 reviewed Optimization Lab foundations: read-only Skill snapshots,
      // the shared file lock, and text-connection resolution (§5.2 of the plan).
      // +1 type-only LifetimeScope/Disposable contract lets capability modules
      // declare owned resources without exposing Host parser/runtime authority.
      // +3 P2 declarations: Host binding/hash/types and the isolated instruction
      // runner, consumed by optimization-lab. The stable SDK stays unchanged.
      // +4 reviewed extension statements: memory-only ephemeral signer factory,
      // read-only current logical/physical attempt identities, and signer type.
      // Isolated capability Hosts own the ephemeral signer's disposal.
      // +1 the same type-only routing declarations for capability-owned presets.
      // +1 reviewed host MCP declaration encoder/type, consumed by Desktop's
      // process host without persisting servers or exposing credentials.
      // +2 narrow external model-call observer and input type. Capability callers
      // cannot configure stores or overwrite inherited execution/privacy scope.
      // Seven existing Link contract/catalog statements landed before this task.
      // This change adds no extension exports; pin that measured HEAD baseline.
      "packages/core/src/index.extension.ts": 68,
      // Shared crash-safe persistence primitives and the Desktop-owned
      // background job registry are host-only API.
      // Speech model resolution adds one reviewed host-only module, shared by
      // transcription, voice generation and Desktop media capability checks.
      // It remains outside the stable public SDK and extension surfaces.
      // Panel connection discovery and sealed tool hand-offs share the existing
      // catalog resolver (+1); credentials remain on the reviewed Host surface.
      // Verified application-owned runtime discovery adds one Host-only module;
      // it neither selects executables for consumers nor grants execution.
      // Offline project settings inspection, reviewed repair and exact rollback
      // add one Host-only module for the administrator CLI. The public SDK and
      // extension contracts do not expose configuration recovery authority.
      // Task Center requires one source-fenced background lifecycle module for
      // Host registries. Listing/cancellation stay off public and extension APIs.
      // +2 reviewed upload Host seams: exact-file index invalidation for the
      // upload lifecycle, and a verified managed parser executable resolver for
      // Desktop/stdio. Neither is exported by the public/extension entries.
      // +4 Host-only statements provide durable key custody, persisted owner
      // validation, private worker/default-signer adapters and their types.
      // None grants renderer or model RPC access to signing keys.
      // +1 Host-only journal reader/writer/type statement. No stable SDK growth.
      // +2 Host-only statements expose the pure Profile switch planner and
      // existing direct-override fold; stable SDK and extension exports are unchanged.
      // +1 static export snapshot/type Host seam, with no stable SDK growth.
      // +1 existing canonical input projection shared by Core and Desktop's
      // owned external Runtime journal; avoids divergent input/attachment rules.
      // It adds no stable public SDK or extension surface or execution authority.
      // +1 native activity review store for masked receipts and CAS operator decisions.
      // Desktop Main is its sole consumer; no worker/model/public SDK resolution authority.
      // +3 reviewed Host-only contracts: native operation Hook host, constrained
      // process host, and its opaque permit/resource/runtime types. Published
      // public/extension contracts remain unchanged; allow no future exports.
      // +3 Host-only collection validation, selected-file capture/read and public-HTTPS transport.
      // +1 Host-only Session coverage proof/store; the stable SDK does not export it.
      // +1 generic cross-process workspace write lock, shared by Desktop and Server.
      // +4 Native batch Host-only declarations: issuer/policy, persisted owner,
      // existing Link authority helpers, and private worker RPC frame/types.
      // No model, stable public SDK or extension authority is added.
      // +1 Host-only static composer SVG validator shared by installer and Main.
      // Public/extension surfaces stay unchanged; no future growth allowance.
      // The reviewed run-timing owner is shared by native Engine runs and
      // Desktop's external runtime recorder. One Host-only export statement
      // exposes that lifecycle seam; the stable public SDK surface is unchanged.
      // +1 reviewed Host composition of the existing operation controller and
      // resolver for external runtime run custody; public SDK and extension runtime
      // exports stay unchanged.
      // +2 Host-only model trace store/configuration/context and data contracts.
      // The stable public SDK does not gain trace persistence or configuration authority.
      // Pin three already-integrated Host grants: operation owner, session services
      // and Link authority. These were present before model observability.
      // Existing Link legacy-cleanup authority adds one already-integrated statement.
      // +1 bounded native frame decoder shared by Agent shell and Panel process
      // observations; no stable SDK or extension persistence authority is added.
      // +1 Host-only cumulative usage normalizer (c938007c2) so Desktop restores
      // foreground-only cache counters with the same rule as Core.
      // +2 Host 1.2 internal seams: SDK-only bounded MCP connect/list/close,
      // and the existing session listing algorithm with Host filesystem custody.
      // Neither is exported by the stable public SDK or extension entry.
      // +4 Host-only memory seams (d93a3ab9e) so Desktop maintains memory for external
      // runtime sessions: MemoryOrchestrator (+ options type), the ephemeral-session check
      // and the shared content sanitizer. None reaches the public SDK or extension entry.
      // Host-only checkpoint service plus its shared type-only contract.
      // +1 shared configured-text resolver: authorized Host and Worker resolve the same
      // Session/profile connection without falling back to a different shared boot pool.
      // +1 Host-only background continuation seam: Desktop's external runtime
      // delivers background results through the same controller as native Sessions.
      // +1 Core's model-question default rule, so the TUI and the IM relay show the
      // same timeout default Core applies instead of keeping their own copies.
      // +1 the agent/goalGet payload builder, so Desktop's disk fallback and its
      // external runtime answer goalGet with the same shape (incl. goal progress).
      // +1 the native turn-outcome tracker, so Desktop's external runtime stamps
      // `turn_complete.outcome` (and its trigger) with the same rules as Engine.
      "packages/core/src/index.internal.ts": 134,
      "packages/coding/src/index.ts": 12,
      // +1 for conversation-session.ts, which re-exports the four modules
      // behind entering a Work Session from a chat (route record, IM list,
      // visit receipt, deterministic commands). They are one feature and are
      // consumed together, so the barrel gains a single line rather than four.
      // +2 reviewed Pet-owned contracts: registered-follow-ups provides the
      // versioned obligation/mutation types and validators; context-recall
      // provides bounded memory selection and source/task relevance types.
      // Desktop Main consumes both through this entry. Persistence, scheduling,
      // delivery and authorization remain Host-owned, with no Core SDK growth.
      // Preserve the existing exports/subpaths and pin the actual 27 statements;
      // this adds no allowance for future compatibility-surface growth.
      "packages/pet/src/index.ts": 27,
      // Desktop and Hub share the extracted desktop-web, links and panels
      // entry points (+3); their HTTP/service implementations remain in server
      // so Desktop adapters no longer own separate copies of those services.
      "packages/server/src/index.ts": 7,
      // Shared transcript replay (+1) folds persisted records through the web
      // stream reducer, giving reconnecting clients the same message state.
      // Environment identity and project-reference contracts are shared by the
      // desktop remote entry and standalone Web; no platform authority is exported.
      // +2 browser-safe Link challenge controller/presentation modules shared by
      // Desktop and Web; transport custody, token refresh and grants remain Host
      // responsibilities. These modules import no native/credential authority.
      // +1 shared bounded output-journal recovery reducer statement.
      // +1 browser-safe coverage validator shared by Desktop and paired Mobile.
      // +2 browser-only trace API contracts/requester and shared read-only explorer.
      // Workspace authorization and recording policy remain on the Host.
      // +1 explicit history-recovery confirmation UI; it receives transport callbacks only.
      // +2 reviewed browser-safe account feature policy and profile normalization.
      // Both are pure projections; credentials and transport remain in the Host.
      "packages/web/src/index.ts": 26,
      // Optional pure-Node account entry shared by Desktop, TUI and serve.
      // Existing Desktop implementations moved here; no Core SDK authority added.
      "packages/server/src/index.account.ts": 11,
    };
    for (const [path, budget] of Object.entries(exportBudgets)) {
      expect(matches(path, /^export /gm), path).toBeLessThanOrEqual(budget);
    }
  });
});
