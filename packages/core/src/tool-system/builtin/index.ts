/**
 * Built-in tool registration.
 */

import type { RegisteredTool } from "../../types.js";
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
import { applyPatchToolDef, applyPatchTool } from "./apply-patch/index.js";
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
import {
  enterWorktreeToolDef,
  enterWorktreeTool,
  exitWorktreeToolDef,
  exitWorktreeTool,
  switchSessionWorkspaceToolDef,
  switchSessionWorkspaceTool,
} from "./worktree.js";
import { sleepToolDef, sleepTool } from "./sleep.js";
import { configToolDef, configTool } from "./config.js";
import { notebookEditToolDef, notebookEditTool } from "./notebook-edit.js";
import { lspToolDef, lspTool } from "./lsp.js";
import {
  cronCreateToolDef,
  cronCreateTool,
  cronDeleteToolDef,
  cronDeleteTool,
  cronListToolDef,
  cronListTool,
} from "./cron.js";
import {
  driveClaudeCodeToolDef,
  driveClaudeCodeTool,
  driveAgentToolDef,
  driveAgentTool,
  DRIVE_AGENT_TOOL_TIMEOUT_MS,
} from "./drive-claude-code.js";
import { checkQuotaToolDef, checkQuotaTool } from "./check-quota.js";
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
import { briefToolDef, briefTool } from "./brief.js";
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
import { useCredentialToolDef, useCredentialTool } from "../../credentials/use-credential-tool.js";
import {
  injectCredentialToolDef,
  injectCredentialTool,
  isInjectCredentialAvailable,
} from "../../credentials/inject-credential-tool.js";
import { CredentialStore } from "../../credentials/store.js";

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
/**
 * 内置工具返回值:大多数返回纯文本字符串。需要回传图片(或其它结构化
 * 内容块)的工具(view_image)可改为返回 `{ contentBlocks }`;此时
 * registry 会把它放进 ToolResult.contentBlocks。可选的 `result` 字段是给
 * transcript / 摘要用的纯文本镜像。沙箱执行类工具(Bash 等)可返回
 * `{ result, sandbox }`,registry 把 sandbox 透传到 ToolResult.sandbox 供 UI 显示。
 */
export type BuiltinToolResult =
  | string
  | { contentBlocks: import("../../types.js").ContentBlock[]; result?: string }
  | { result: string; sandbox: import("../../types.js").ToolResult["sandbox"] };

export type BuiltinToolFn = (
  args: Record<string, unknown>,
  ctx?: import("../context.js").ToolContext,
) => Promise<BuiltinToolResult>;

export type BuiltinToolGuard = (ctx: ToolVisibilityContext) => boolean;

export interface BuiltinTool {
  definition: RegisteredTool;
  execute: BuiltinToolFn;
}

export const BUILTIN_TOOLS: BuiltinTool[] = [
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
      permissionDefault: "ask", // writes user config — confirm before each write
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
      ...applyPatchToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      pathPolicy: [{ kind: "apply_patch", arg: "patch", operation: "write" }],
    },
    execute: applyPatchTool,
  },
  {
    definition: {
      ...globToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
      pathPolicy: [{ kind: "arg", arg: "path", operation: "read", defaultToCwd: true }],
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
  {
    definition: {
      ...enterWorktreeToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: enterWorktreeTool,
  },
  {
    definition: {
      ...exitWorktreeToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: exitWorktreeTool,
  },
  {
    definition: {
      ...switchSessionWorkspaceToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: switchSessionWorkspaceTool,
  },
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
  {
    definition: {
      ...notebookEditToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      pathPolicy: [
        {
          kind: "arg",
          arg: "file_path",
          operation: { fromArg: "action", readValues: ["read"], default: "write" },
        },
      ],
    },
    execute: notebookEditTool,
  },
  // ─── Phase 6: LSP ─────────────────────────────────────────────
  {
    definition: {
      ...lspToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
      pathPolicy: [{ kind: "arg", arg: "file_path", operation: "read" }],
    },
    execute: lspTool,
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
  // ─── Drive external coding-agent CLI (claude / codex) ──────────
  {
    definition: {
      ...driveAgentToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      timeoutMs: DRIVE_AGENT_TOOL_TIMEOUT_MS,
    },
    execute: driveAgentTool,
  },
  // Back-compat alias: DriveClaudeCode = DriveAgent pinned to cli:claude. Kept
  // registered so old prompts/memories that name DriveClaudeCode still resolve.
  {
    definition: {
      ...driveClaudeCodeToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      timeoutMs: DRIVE_AGENT_TOOL_TIMEOUT_MS,
    },
    execute: driveClaudeCodeTool,
  },
  // ─── Check remaining CC/Codex subscription quota ──────────────
  {
    definition: {
      ...checkQuotaToolDef,
      source: "builtin",
      // Read-only intent (reports quota, mutates nothing). Note: the "claude"
      // path sends a 1-token probe (Anthropic exposes quota only via response
      // headers) — that tiny cost is documented in the tool description.
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: checkQuotaTool,
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
      ...briefToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: briefTool,
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
  // browser_observe is read-only. browser_act is permissionDefault "allow"; its
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
      permissionDefault: "allow", // per-action gating via preset rule (argsPattern.action)
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
  // ─── Credentials: AI 取用已存凭证(token/link/cookie) ──────────
  // permissionDefault:"allow" —— 取用审批由工具内部的 CredentialUseGate 负责
  // (默认问/本会话记住/全自动),不走工具级权限层,避免双重弹窗。
  // 读取凭证库本身不写文件(cookie 物化成临时 cookies.txt 是用完即弃的副产物)。
  {
    definition: {
      ...useCredentialToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: useCredentialTool,
  },
  // InjectCredential:把 cookie 凭证注入内置浏览器(恢复登录态)。审批由工具内部
  // CredentialUseGate 负责(逐条 autoInjectByAI),故 permissionDefault:"allow"。
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

/**
 * Per-tool availability predicates. A tool listed here is filtered OUT of the
 * exposed toolDefs when its predicate returns false for the active cwd (see
 * engine.ts toolDefs assembly). Tools NOT listed here are always visible.
 * Keyed by the tool's `name` (must match the toolDef name).
 */
export const BUILTIN_TOOL_GUARDS: Map<string, BuiltinToolGuard> = new Map([
  [webSearchToolDef.name, (ctx) => isWebSearchAvailable(ctx.cwd)],
  [generateImageToolDef.name, (ctx) => isGenerateImageAvailable(ctx.cwd)],
  [generateVideoToolDef.name, (ctx) => isGenerateVideoAvailable(ctx.cwd)],
  // UseCredential is hidden until at least one credential exists — keeps it out
  // of the tool list (and the context) for the common no-credentials case,
  // matching the spec's "quiet when empty" intent (true ToolSearch-deferral for
  // builtins isn't wired in the engine).
  [useCredentialToolDef.name, (ctx) => isUseCredentialAvailable(ctx.cwd)],
  // InjectCredential hidden until ≥1 cookie credential exists (browser injection
  // is cookie-only). Also degrades at call time if no browser bridge is wired.
  [injectCredentialToolDef.name, (ctx) => isInjectCredentialAvailable(ctx.cwd, ctx.settingsScope)],
  [completeGoalToolDef.name, (ctx) => ctx.hasGoal === true],
  [cancelGoalToolDef.name, (ctx) => ctx.hasGoal === true],
]);

/** UseCredential is available when the cwd's CredentialStore has ≥1 credential. */
export function isUseCredentialAvailable(cwd: string): boolean {
  try {
    return new CredentialStore(cwd).listMasked().length > 0;
  } catch {
    return false;
  }
}
