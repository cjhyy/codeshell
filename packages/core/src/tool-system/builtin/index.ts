/**
 * Built-in tool registration.
 */

import type { RegisteredTool } from "../../types.js";
import { readToolDef, readTool } from "./read.js";
import { writeToolDef, writeTool } from "./write.js";
import { generateImageToolDef, generateImageTool, isGenerateImageAvailable } from "./generate-image.js";
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
  agentToolDef, agentTool,
  agentStatusToolDef, agentStatusTool,
  agentCancelToolDef, agentCancelTool,
} from "./agent.js";
import { enterPlanModeToolDef, enterPlanModeTool, exitPlanModeToolDef, exitPlanModeTool } from "./plan.js";
import { toolSearchToolDef, toolSearchTool } from "./tool-search.js";
import { todoWriteToolDef, todoWriteTool } from "./task.js";
import { enterWorktreeToolDef, enterWorktreeTool, exitWorktreeToolDef, exitWorktreeTool } from "./worktree.js";
import { sendMessageToolDef, sendMessageTool } from "./send-message.js";
import { sleepToolDef, sleepTool } from "./sleep.js";
import { configToolDef, configTool } from "./config.js";
import { notebookEditToolDef, notebookEditTool } from "./notebook-edit.js";
import { lspToolDef, lspTool } from "./lsp.js";
import { cronCreateToolDef, cronCreateTool, cronDeleteToolDef, cronDeleteTool, cronListToolDef, cronListTool } from "./cron.js";
import { skillToolDef, skillTool } from "./skill.js";
import { mcpToolDef, mcpToolExecute, listMcpResourcesToolDef, listMcpResourcesTool, readMcpResourceToolDef, readMcpResourceTool } from "./mcp-tools.js";
import { remoteTriggerToolDef, remoteTriggerTool } from "./remote-trigger.js";
import { replToolDef, replTool } from "./repl.js";
import { briefToolDef, briefTool } from "./brief.js";
import { powershellToolDef, powershellTool } from "./powershell.js";
import { arenaToolDef, arenaTool } from "./arena.js";
import {
  memoryListToolDef, memoryListTool,
  memoryReadToolDef, memoryReadTool,
  memorySaveToolDef, memorySaveTool,
  memoryDeleteToolDef, memoryDeleteTool,
} from "./memory.js";
import { completeGoalToolDef, completeGoalTool } from "./complete-goal.js";
import { addMarketplaceToolDef, addMarketplaceTool } from "./add-marketplace.js";

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
 * transcript / 摘要用的纯文本镜像。
 */
export type BuiltinToolResult =
  | string
  | { contentBlocks: import("../../types.js").ContentBlock[]; result?: string };

export type BuiltinToolFn = (
  args: Record<string, unknown>,
  ctx?: import("../context.js").ToolContext,
) => Promise<BuiltinToolResult>;

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
    },
    execute: writeTool,
  },
  {
    definition: {
      ...generateImageToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      timeoutMs: 600_000, // 10min — high-quality / large image generation routinely exceeds the 120s default; give slow renders ample room while still bounding a hung request (Stop / ctx.signal cancels sooner)
    },
    execute: generateImageTool,
  },
  {
    definition: {
      ...viewImageToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
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
      ...sendMessageToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: false,
      isConcurrencySafe: true,
    },
    execute: sendMessageTool,
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
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: readMcpResourceTool,
  },
  {
    definition: {
      ...remoteTriggerToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    execute: remoteTriggerTool,
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
];

/**
 * Per-tool availability predicates. A tool listed here is filtered OUT of the
 * exposed toolDefs when its predicate returns false for the active cwd (see
 * engine.ts toolDefs assembly). Tools NOT listed here are always visible.
 * Keyed by the tool's `name` (must match the toolDef name).
 */
export const BUILTIN_TOOL_GUARDS: Map<string, (cwd: string) => boolean> = new Map([
  [webSearchToolDef.name, isWebSearchAvailable],
  [generateImageToolDef.name, isGenerateImageAvailable],
]);
