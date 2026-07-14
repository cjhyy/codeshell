/**
 * Built-in tool registration.
 */

import type { PermissionRule, RegisteredTool } from "../../types.js";
import type { ToolVisibilityContext } from "../context.js";
import { readToolDef, readTool } from "./read.js";
import { writeToolDef, writeTool } from "./write.js";
import {
  generateImageToolDef,
  generateImageTool,
  isGenerateImageAvailable,
} from "./generate-image.js";
import { editModelCatalogToolDef, editModelCatalogTool } from "./edit-model-catalog.js";
import {
  generateVideoToolDef,
  generateVideoTool,
  isGenerateVideoAvailable,
} from "./generate-video.js";
import { viewImageToolDef, viewImageTool } from "./view-image.js";
import { editToolDef, editTool } from "./edit.js";
import { globToolDef, globTool } from "./glob.js";
import { grepToolDef, grepTool } from "./grep.js";
import { bashToolDef, bashTool } from "./bash.js";
import { webSearchToolDef, webSearchTool, isWebSearchAvailable } from "./web-search.js";
import { webFetchToolDef, webFetchTool } from "./web-fetch.js";
import { askUserToolDef, askUserTool } from "./ask-user.js";
import {
  agentToolDef,
  agentTool,
  agentStatusToolDef,
  agentStatusTool,
  agentCancelToolDef,
  agentCancelTool,
  agentSendInputToolDef,
  agentSendInputTool,
} from "./agent.js";
import {
  enterPlanModeToolDef,
  enterPlanModeTool,
  exitPlanModeToolDef,
  exitPlanModeTool,
} from "./plan.js";
import { toolSearchToolDef, toolSearchTool } from "./tool-search.js";
import { todoWriteToolDef, todoWriteTool } from "./task.js";
import { sleepToolDef } from "./sleep.definition.js";
import { sleepTool } from "./sleep.js";
import { configToolDef, configTool } from "./config.js";
import {
  cronCreateToolDef,
  cronCreateTool,
  cronDeleteToolDef,
  cronDeleteTool,
  cronListTool,
} from "./cron.js";
import { cronListToolDef } from "./cron-list.definition.js";
import { skillToolDef, skillTool } from "./skill.js";
import {
  mcpToolDef,
  mcpToolExecute,
  listMcpResourcesToolDef,
  listMcpResourcesTool,
  readMcpResourceToolDef,
  readMcpResourceTool,
} from "./mcp-tools.js";
import { replToolDef, replTool } from "./repl.js";
import { powershellToolDef, powershellTool } from "./powershell.js";
import { arenaToolDef, arenaTool } from "./arena.js";
import {
  memoryListToolDef,
  memoryListTool,
  memoryReadToolDef,
  memoryReadTool,
  memorySaveToolDef,
  memorySaveTool,
  memoryDeleteToolDef,
  memoryDeleteTool,
} from "./memory.js";
import { completeGoalToolDef, completeGoalTool } from "./complete-goal.js";
import { cancelGoalToolDef, cancelGoalTool } from "./cancel-goal.js";
import { addMarketplaceToolDef, addMarketplaceTool } from "./add-marketplace.js";
import {
  bashOutputToolDef,
  bashOutputTool,
  killShellToolDef,
  killShellTool,
  listShellsToolDef,
  listShellsTool,
} from "./background-shell-tools.js";
import {
  browserObserveToolDef,
  browserObserveTool,
  browserActToolDef,
  browserActTool,
  browserNavigateToolDef,
  browserNavigateTool,
} from "./browser-tools.js";
import { panelToolDef, panelTool } from "./panel.js";
import {
  useCredentialToolDef,
  useCredentialBuiltinTool,
} from "../../credentials/use-credential-tool.js";
import {
  injectCredentialToolDef,
  injectCredentialTool,
  isInjectCredentialAvailable,
} from "../../credentials/inject-credential-tool.js";
import { credentialAccessScope, getCredentialAccess } from "../../credentials/access.js";

/**
 * Tool executor signature.
 *
 * Tools may inspect ctx for runtime services (askUser, llmConfig, modelPool,
 * toolRegistry, subAgentSpawner). Tools that don't need any of these — Read,
 * Write, Bash, Edit, Glob, Grep, etc. — may simply ignore the second arg.
 *
 * ctx is optional in the signature so legacy call sites (and tests) that
 * pass only args still type-check; ToolRegistry always passes ctx at runtime.
 */
/** Canonical tool-handler protocol. Only ToolSuccess is recorded as ok:true. */
export interface ToolSuccess {
  ok: true;
  result?: string;
  contentBlocks?: import("../../types.js").ContentBlock[];
  sandbox?: import("../../types.js").ToolResult["sandbox"];
  sensitive?: boolean;
  displayResult?: string;
  transcriptResult?: string;
}

export interface ToolFailure {
  ok: false;
  error: string;
  sandbox?: import("../../types.js").ToolResult["sandbox"];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
}

export type ToolExecutionResult = ToolSuccess | ToolFailure;
export type BuiltinToolResult = ToolExecutionResult;

/** Direct implementation shape, normalized before entering the registry. */
export type BuiltinToolReturn =
  | string
  | BuiltinToolResult
  | { contentBlocks: import("../../types.js").ContentBlock[]; result?: string }
  | {
      result: string;
      sandbox?: import("../../types.js").ToolResult["sandbox"];
      sensitive?: boolean;
      displayResult?: string;
      transcriptResult?: string;
    };

type BuiltinToolImplementation = (
  args: Record<string, unknown>,
  ctx?: import("../context.js").ToolContext,
) => Promise<unknown>;

export type BuiltinToolFn = (
  args: Record<string, unknown>,
  ctx?: import("../context.js").ToolContext,
) => Promise<string | BuiltinToolResult>;

const FAILURE_TEXT =
  /^(?:error\b|failed\b|failure\b|skill\b.*(?:not found\b|disabled\b|not available\b|allowlist\b|denied\b)|(?:[a-z][\w-]*\s+){1,3}(?:error\b|failed\b|failure\b|aborted\b|timed out\b))/i;

function failureMessage(result: Record<string, unknown>): string {
  if (typeof result.error === "string" && result.error) return result.error;
  if (typeof result.result === "string" && result.result) return result.result;
  return "Tool execution failed";
}

/** Convert every builtin implementation into the closed discriminated protocol. */
export function toToolExecutionResult(value: unknown): ToolExecutionResult {
  if (typeof value === "string") {
    return FAILURE_TEXT.test(value) ? { ok: false, error: value } : { ok: true, result: value };
  }
  if (!value || typeof value !== "object") {
    return { ok: false, error: `Invalid tool result: ${String(value)}` };
  }

  const result = value as Record<string, unknown>;
  if (result.ok === false || result.isError === true || "error" in result) {
    return {
      ...(result as Omit<ToolFailure, "ok" | "error">),
      ok: false,
      error: failureMessage(result),
    };
  }
  if (result.ok === true) return result as unknown as ToolSuccess;

  const text = typeof result.result === "string" ? result.result : undefined;
  if (text && FAILURE_TEXT.test(text)) {
    return {
      ok: false,
      error: text,
      ...(result.sandbox ? { sandbox: result.sandbox as ToolFailure["sandbox"] } : {}),
    };
  }
  return { ok: true, ...(result as Omit<ToolSuccess, "ok">) };
}

export type BuiltinToolGuard = (ctx: ToolVisibilityContext) => boolean;

export interface BuiltinTool {
  definition: RegisteredTool;
  execute: BuiltinToolFn;
  exposure: BuiltinToolExposure;
}

export interface BuiltinToolExposure {
  /** Empty means explicit enableBuiltinTools-only. */
  presetTags: readonly string[];
  /** Execution policy is explicit and never inferred from permissionDefault. */
  defaultPermissionRules?: readonly PermissionRule[];
  /** Prompt sections enabled whenever at least one contributing tool is active. */
  promptSections?: readonly string[];
  /** Complete capability companions that must share every preset tag. */
  requires?: readonly string[];
  /** Shared by model visibility and the executor's second safety gate. */
  availability?: BuiltinToolGuard;
}

const BUILTIN_IMPLEMENTATIONS: Array<{
  definition: RegisteredTool;
  execute: BuiltinToolImplementation;
}> = [
  {
    definition: {
      ...readToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
      pathPolicy: [{ kind: "arg", arg: "file_path", operation: "read" }],
    },
    execute: readTool,
  },
  {
    definition: {
      ...writeToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      pathPolicy: [{ kind: "arg", arg: "file_path", operation: "write" }],
    },
    execute: writeTool,
  },
  {
    definition: {
      ...editModelCatalogToolDef,
      source: "builtin",
      permissionDefault: "ask", // UI hint; default classifier fallback confirms writes.
      isReadOnly: false,
      isConcurrencySafe: false, // serializes writes to the single catalog file
    },
    execute: editModelCatalogTool,
  },
  {
    definition: {
      ...generateImageToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      // Independent external I/O with no shared state — same class as WebFetch/GenerateVideo.
      // Each call writes its own collision-free file (Date.now()+random suffix), so N images
      // in one turn run concurrently (~3min for 6 instead of ~15min serial). Dependent chains
      // (image → video) are forced across turns and serialize naturally via the drain barrier.
      isConcurrencySafe: true,
      timeoutMs: 600_000, // 10min — high-quality / large image generation routinely exceeds the 120s default; give slow renders ample room while still bounding a hung request (Stop / ctx.signal cancels sooner)
      // `referenceImages` are local files read off disk and shipped to the
      // provider — gate them through the path-policy layer like Read, so an
      // out-of-workspace ref ("../../etc/passwd") prompts for approval instead
      // of silently leaking. (array arg → executor enforces each element)
      pathPolicy: [{ kind: "arg", arg: "referenceImages", operation: "read" }],
    },
    execute: generateImageTool,
  },
  {
    definition: {
      ...generateVideoToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: true,
      // Returns fast (fire-and-forget: submits + backgrounds the poll loop),
      // so the default timeout is plenty — the long poll runs detached.
      // `images`/`image` may be local files (uploaded to the provider) — same
      // path-policy gating as GenerateImage's referenceImages.
      pathPolicy: [
        { kind: "arg", arg: "images", operation: "read" },
        { kind: "arg", arg: "image", operation: "read" },
      ],
    },
    execute: generateVideoTool,
  },
  {
    definition: {
      ...viewImageToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
      pathPolicy: [{ kind: "arg", arg: "path", operation: "read" }],
    },
    execute: viewImageTool,
  },
  {
    definition: {
      ...editToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      pathPolicy: [{ kind: "arg", arg: "file_path", operation: "write" }],
    },
    execute: editTool,
  },
  {
    definition: {
      ...globToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
      pathPolicy: [
        { kind: "arg", arg: "path", operation: "read", defaultToCwd: true },
        { kind: "arg", arg: "pattern", operation: "read" },
      ],
    },
    execute: globTool,
  },
  {
    definition: {
      ...grepToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
      pathPolicy: [{ kind: "arg", arg: "path", operation: "read", defaultToCwd: true }],
    },
    execute: grepTool,
  },
  {
    definition: {
      ...bashToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      timeoutMs: 3_600_000, // 1h — supports long-running shell loops (e.g. `until` polling)
    },
    execute: bashTool,
  },
  // ─── Background shells (Bash run_in_background companions) ──────
  {
    definition: {
      ...bashOutputToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: bashOutputTool,
  },
  {
    definition: {
      ...killShellToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: killShellTool,
  },
  {
    definition: {
      ...listShellsToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: listShellsTool,
  },
  {
    definition: {
      ...webSearchToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: webSearchTool,
  },
  {
    definition: {
      ...webFetchToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: webFetchTool,
  },
  {
    definition: {
      ...askUserToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: false,
      timeoutMs: 0, // 纯等待用户操作 — 不设超时，由用户 Esc/取消
    },
    execute: askUserTool,
  },
  {
    definition: {
      ...agentToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
      timeoutMs: 1_800_000, // 30min — sub-agent runs may execute many tool calls
    },
    execute: agentTool,
  },
  {
    definition: {
      ...agentStatusToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: agentStatusTool,
  },
  {
    definition: {
      ...agentCancelToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: agentCancelTool,
  },
  {
    definition: {
      ...agentSendInputToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
      timeoutMs: 1_800_000, // 30min — a continuation may execute many tool calls, like Agent
    },
    execute: agentSendInputTool,
  },
  {
    definition: {
      ...enterPlanModeToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: false,
    },
    execute: enterPlanModeTool,
  },
  {
    definition: {
      ...exitPlanModeToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: false,
    },
    execute: exitPlanModeTool,
  },
  {
    definition: {
      ...toolSearchToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: toolSearchTool,
  },
  {
    definition: {
      ...todoWriteToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: todoWriteTool,
  },
  // ─── Phase 4: Multi-Agent + Worktree ───────────────────────────
  // ─── Phase 5: Utility Tools ────────────────────────────────────
  {
    definition: {
      ...sleepToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: sleepTool,
  },
  {
    definition: {
      ...configToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: configTool,
  },
  // ─── Cron Tools ────────────────────────────────────────────────
  {
    definition: {
      ...cronCreateToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: cronCreateTool,
  },
  {
    definition: {
      ...cronDeleteToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: cronDeleteTool,
  },
  {
    definition: {
      ...cronListToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: cronListTool,
  },
  // ─── Phase 7: Missing tools from restored-src ─────────────────
  {
    definition: {
      ...skillToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: skillTool,
  },
  {
    definition: {
      ...mcpToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: true,
    },
    execute: mcpToolExecute,
  },
  {
    definition: {
      ...listMcpResourcesToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: listMcpResourcesTool,
  },
  {
    definition: {
      ...readMcpResourceToolDef,
      source: "builtin",
      // Reading resource CONTENT (unlike enumerating names) can pull arbitrary
      // data — potentially secrets — from a connected MCP server. Default to ask
      // rather than the old unconditional allow so a default-mode session
      // confirms the read; the executor also gates the target server against the
      // session's allowedMcpServers.
      permissionDefault: "ask",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: readMcpResourceTool,
  },
  {
    definition: {
      ...replToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: replTool,
  },
  {
    definition: {
      ...powershellToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: powershellTool,
  },
  // ─── Arena: Multi-Model Collaborative Analysis ────────────────
  {
    definition: {
      ...arenaToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: true,
      isConcurrencySafe: false,
      timeoutMs: 1_800_000, // 30min — multi-model debate rounds take time
    },
    execute: arenaTool,
  },
  // ─── Memory tools (persistent cross-session memory) ────────────
  // Save/Delete default to "ask" so user-scope modifications go through a
  // permission prompt; dream-scope is whitelisted via a PermissionRule in
  // Engine.buildPermissionConfig so the LLM can freely manage its own
  // workspace without prompting.
  {
    definition: {
      ...memoryListToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: memoryListTool,
  },
  {
    definition: {
      ...memoryReadToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: memoryReadTool,
  },
  {
    definition: {
      ...memorySaveToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: memorySaveTool,
  },
  {
    definition: {
      ...memoryDeleteToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: memoryDeleteTool,
  },
  // ─── Goal mode: model-declared completion ──────────────────────
  // Lets the model explicitly declare the active goal complete. The
  // turn-loop short-circuits on this call; the tool itself only records an
  // acknowledgement string, so it's read-only and concurrency-safe.
  {
    definition: {
      ...completeGoalToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: completeGoalTool,
  },
  // ─── Goal mode: user-initiated cancellation ────────────────────
  // Distinct from complete_goal — the user explicitly asked to abandon the
  // goal. The turn-loop short-circuits on this call (only when confirm===true)
  // AND clears the persisted goal. The tool itself only records an
  // acknowledgement string, so it's read-only and concurrency-safe.
  {
    definition: {
      ...cancelGoalToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: cancelGoalTool,
  },
  // ─── Plugin marketplace: model-driven source registration ──────
  {
    definition: {
      ...addMarketplaceToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      timeoutMs: 120_000, // git clone over network
    },
    execute: addMarketplaceTool,
  },
  // Browser automation — 3 semantic tools driving the in-app webview via the
  // BrowserBridge (CDP). All serial on one webview (isConcurrencySafe:false).
  // browser_observe is read-only. browser_act declares a UI hint of allow; its
  // sensitive actions (click/type/select) are escalated to "ask" by a preset
  // PermissionRule keyed on argsPattern { action } (see preset/index.ts §4.6) —
  // so one tool carries per-action gating. Sensitive-action + domain-whitelist
  // enforcement also lives main-side in the bridge. Tools self-gate to
  // unavailable when no bridge is wired (headless).
  {
    definition: {
      ...browserObserveToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: false,
      timeoutMs: 30_000, // wait/observe can sit through a load; RPC headroom
    },
    execute: browserObserveTool,
  },
  {
    definition: {
      ...browserActToolDef,
      source: "builtin",
      permissionDefault: "allow", // UI hint; per-action execution gating is the preset rule.
      isReadOnly: false,
      isConcurrencySafe: false,
      timeoutMs: 30_000, // the wait action internally bounds; give RPC headroom
    },
    execute: browserActTool,
  },
  {
    definition: {
      ...browserNavigateToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: browserNavigateTool,
  },
  // Generic host-panel control. The bridge is injected only by interactive
  // Desktop sessions; plugin tools can call the same ctx.panels service.
  {
    definition: {
      ...panelToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: panelTool,
  },
  // ─── Credentials: AI 取用已存凭证(token/link/cookie) ──────────
  // permissionDefault:"allow" 是展示/声明 hint；取用审批由工具内部的
  // CredentialUseGate 负责(默认问/本会话记住/全自动),避免双重弹窗。
  // 读取凭证库本身不写文件(cookie 物化成临时 cookies.txt 是用完即弃的副产物)。
  {
    definition: {
      ...useCredentialToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: useCredentialBuiltinTool,
  },
  // InjectCredential:把 cookie 凭证注入内置浏览器(恢复登录态)。审批由工具内部
  // CredentialUseGate 负责(逐条 autoInjectByAI),permissionDefault:"allow" 仅作展示 hint。
  // 改浏览器登录态有副作用 → 非 read-only。
  {
    definition: {
      ...injectCredentialToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: injectCredentialTool,
  },
];

const GENERAL_TAGS = ["general"] as const;
const HARNESS_TAGS = ["harness-min", "general"] as const;
const PRODUCT_FULL_TAGS = ["product-full"] as const;
const EXPLICIT_ONLY = [] as const;

function expose(
  presetTags: readonly string[],
  options: Omit<BuiltinToolExposure, "presetTags"> = {},
): BuiltinToolExposure {
  return { presetTags, ...options };
}

function allow(tool: string): PermissionRule[] {
  return [{ tool, decision: "allow" }];
}

/**
 * Preset-facing metadata lives beside the builtin catalog. The exhaustive
 * registration-time check below makes a newly-added implementation fail loud
 * until its product exposure has been reviewed explicitly.
 */
const BUILTIN_EXPOSURES = new Map<string, BuiltinToolExposure>([
  [readToolDef.name, expose(HARNESS_TAGS, { defaultPermissionRules: allow(readToolDef.name) })],
  [writeToolDef.name, expose(HARNESS_TAGS)],
  [editModelCatalogToolDef.name, expose(GENERAL_TAGS)],
  [
    generateImageToolDef.name,
    expose(GENERAL_TAGS, { availability: (ctx) => isGenerateImageAvailable(ctx.cwd) }),
  ],
  [
    generateVideoToolDef.name,
    expose(GENERAL_TAGS, { availability: (ctx) => isGenerateVideoAvailable(ctx.cwd) }),
  ],
  [viewImageToolDef.name, expose(GENERAL_TAGS)],
  [editToolDef.name, expose(HARNESS_TAGS)],
  [globToolDef.name, expose(HARNESS_TAGS, { defaultPermissionRules: allow(globToolDef.name) })],
  [grepToolDef.name, expose(HARNESS_TAGS, { defaultPermissionRules: allow(grepToolDef.name) })],
  [bashToolDef.name, expose(HARNESS_TAGS, { requires: ["BashOutput", "KillShell", "ListShells"] })],
  [bashOutputToolDef.name, expose(HARNESS_TAGS)],
  [killShellToolDef.name, expose(HARNESS_TAGS)],
  [listShellsToolDef.name, expose(HARNESS_TAGS)],
  [
    webSearchToolDef.name,
    expose(GENERAL_TAGS, {
      defaultPermissionRules: allow(webSearchToolDef.name),
      availability: (ctx) => isWebSearchAvailable(ctx.cwd),
    }),
  ],
  [
    webFetchToolDef.name,
    expose(GENERAL_TAGS, { defaultPermissionRules: allow(webFetchToolDef.name) }),
  ],
  [
    askUserToolDef.name,
    expose(HARNESS_TAGS, { defaultPermissionRules: allow(askUserToolDef.name) }),
  ],
  [agentToolDef.name, expose(HARNESS_TAGS, { defaultPermissionRules: allow(agentToolDef.name) })],
  [agentStatusToolDef.name, expose(EXPLICIT_ONLY)],
  [
    agentCancelToolDef.name,
    expose(HARNESS_TAGS, { defaultPermissionRules: allow(agentCancelToolDef.name) }),
  ],
  [agentSendInputToolDef.name, expose(EXPLICIT_ONLY)],
  [
    enterPlanModeToolDef.name,
    expose(GENERAL_TAGS, { defaultPermissionRules: allow(enterPlanModeToolDef.name) }),
  ],
  [
    exitPlanModeToolDef.name,
    expose(GENERAL_TAGS, { defaultPermissionRules: allow(exitPlanModeToolDef.name) }),
  ],
  [
    toolSearchToolDef.name,
    expose(HARNESS_TAGS, { defaultPermissionRules: allow(toolSearchToolDef.name) }),
  ],
  [
    todoWriteToolDef.name,
    expose(HARNESS_TAGS, { defaultPermissionRules: allow(todoWriteToolDef.name) }),
  ],
  [sleepToolDef.name, expose(HARNESS_TAGS, { defaultPermissionRules: allow(sleepToolDef.name) })],
  [configToolDef.name, expose(HARNESS_TAGS)],
  [cronCreateToolDef.name, expose(GENERAL_TAGS)],
  [cronDeleteToolDef.name, expose(GENERAL_TAGS)],
  [
    cronListToolDef.name,
    expose(GENERAL_TAGS, { defaultPermissionRules: allow(cronListToolDef.name) }),
  ],
  [skillToolDef.name, expose(HARNESS_TAGS, { defaultPermissionRules: allow(skillToolDef.name) })],
  [mcpToolDef.name, expose(HARNESS_TAGS)],
  [
    listMcpResourcesToolDef.name,
    expose(HARNESS_TAGS, { defaultPermissionRules: allow(listMcpResourcesToolDef.name) }),
  ],
  [readMcpResourceToolDef.name, expose(HARNESS_TAGS)],
  [replToolDef.name, expose(GENERAL_TAGS)],
  [powershellToolDef.name, expose(GENERAL_TAGS)],
  [arenaToolDef.name, expose(PRODUCT_FULL_TAGS)],
  [
    memoryListToolDef.name,
    expose(HARNESS_TAGS, { defaultPermissionRules: allow(memoryListToolDef.name) }),
  ],
  [
    memoryReadToolDef.name,
    expose(HARNESS_TAGS, { defaultPermissionRules: allow(memoryReadToolDef.name) }),
  ],
  [memorySaveToolDef.name, expose(HARNESS_TAGS)],
  [memoryDeleteToolDef.name, expose(HARNESS_TAGS)],
  [completeGoalToolDef.name, expose(HARNESS_TAGS, { availability: (ctx) => ctx.hasGoal === true })],
  [cancelGoalToolDef.name, expose(HARNESS_TAGS, { availability: (ctx) => ctx.hasGoal === true })],
  [addMarketplaceToolDef.name, expose(GENERAL_TAGS)],
  [
    browserObserveToolDef.name,
    expose(GENERAL_TAGS, {
      defaultPermissionRules: allow(browserObserveToolDef.name),
      promptSections: ["browser"],
    }),
  ],
  [
    browserActToolDef.name,
    expose(GENERAL_TAGS, {
      defaultPermissionRules: [
        {
          tool: browserActToolDef.name,
          argsPattern: { action: "^(click|type|select)$" },
          decision: "ask",
          reason: "browser_act click/type/select mutate the page",
        },
      ],
      promptSections: ["browser"],
    }),
  ],
  [
    browserNavigateToolDef.name,
    expose(GENERAL_TAGS, {
      defaultPermissionRules: allow(browserNavigateToolDef.name),
      promptSections: ["browser"],
    }),
  ],
  [
    panelToolDef.name,
    expose(GENERAL_TAGS, {
      defaultPermissionRules: allow(panelToolDef.name),
      availability: (ctx) => ctx.host === "desktop" && ctx.isSubAgent !== true,
    }),
  ],
  [
    useCredentialToolDef.name,
    expose(GENERAL_TAGS, {
      availability: (ctx) => isUseCredentialAvailable(ctx.cwd, ctx.settingsScope),
    }),
  ],
  [
    injectCredentialToolDef.name,
    expose(GENERAL_TAGS, {
      availability: (ctx) => isInjectCredentialAvailable(ctx.cwd, ctx.settingsScope),
    }),
  ],
]);

function requiredExposure(name: string): BuiltinToolExposure {
  const exposure = BUILTIN_EXPOSURES.get(name);
  if (!exposure) throw new Error(`Builtin tool '${name}' is missing exposure metadata`);
  return exposure;
}

export const BUILTIN_TOOLS: BuiltinTool[] = BUILTIN_IMPLEMENTATIONS.map(
  ({ definition, execute }) => ({
    definition,
    exposure: requiredExposure(definition.name),
    execute: async (args, ctx) => toToolExecutionResult(await execute(args, ctx)),
  }),
);

const KNOWN_TOOL_PROMPT_SECTIONS = new Set(["browser"]);

export function validateBuiltinToolExposures(tools: readonly BuiltinTool[] = BUILTIN_TOOLS): void {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  if (byName.size !== tools.length)
    throw new Error("Builtin tool catalog contains duplicate names");
  for (const tool of tools) {
    const { name } = tool.definition;
    if (!Array.isArray(tool.exposure.presetTags)) {
      throw new Error(`Builtin tool '${name}' is missing presetTags`);
    }
    for (const section of tool.exposure.promptSections ?? []) {
      if (!KNOWN_TOOL_PROMPT_SECTIONS.has(section)) {
        throw new Error(`Builtin tool '${name}' references unknown prompt section '${section}'`);
      }
    }
    for (const requiredName of tool.exposure.requires ?? []) {
      const required = byName.get(requiredName);
      if (!required)
        throw new Error(`Builtin tool '${name}' requires unknown tool '${requiredName}'`);
      for (const tag of tool.exposure.presetTags) {
        if (!required.exposure.presetTags.includes(tag)) {
          throw new Error(`Builtin tool '${name}' requires '${requiredName}' in preset '${tag}'`);
        }
      }
    }
  }
}

validateBuiltinToolExposures();

/** Derive a preset's tool list and safe defaults from any composed tool catalog. */
export function derivePresetExposure(
  tag: string,
  tools: readonly BuiltinTool[] = BUILTIN_TOOLS,
): {
  builtinTools: string[];
  defaultPermissionRules: PermissionRule[];
} {
  const selected = tools.filter((tool) => tool.exposure.presetTags.includes(tag));
  return {
    builtinTools: selected.map((tool) => tool.definition.name),
    defaultPermissionRules: selected.flatMap((tool) => [
      ...(tool.exposure.defaultPermissionRules ?? []),
    ]),
  };
}

/** Backwards-compatible name for callers deriving only from the core catalog. */
export function deriveBuiltinPresetExposure(tag: string): {
  builtinTools: string[];
  defaultPermissionRules: PermissionRule[];
} {
  return derivePresetExposure(tag, BUILTIN_TOOLS);
}

export function deriveToolGatedPromptSections(
  tools: readonly BuiltinTool[] = BUILTIN_TOOLS,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const tool of tools) {
    for (const section of tool.exposure.promptSections ?? []) {
      (result[section] ??= []).push(tool.definition.name);
    }
  }
  return result;
}

/** Compatibility view consumed by engine + executor; metadata is authoritative. */
export const BUILTIN_TOOL_GUARDS: Map<string, BuiltinToolGuard> = new Map(
  BUILTIN_TOOLS.flatMap((tool) =>
    tool.exposure.availability
      ? ([[tool.definition.name, tool.exposure.availability]] as const)
      : [],
  ),
);

/** UseCredential is available when the cwd's credential metadata has ≥1 entry. */
export function isUseCredentialAvailable(
  cwd: string,
  settingsScope?: import("../../settings/manager.js").SettingsScope,
): boolean {
  try {
    return getCredentialAccess().listMasked(cwd, credentialAccessScope(settingsScope)).length > 0;
  } catch {
    return false;
  }
}
