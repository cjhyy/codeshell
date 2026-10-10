import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUILTIN_AGENT_PRESETS,
  BUILTIN_TOOLS,
  derivePresetExposure,
  type AgentModule,
  type AgentPreset,
  type BuiltinTool,
  type RegisteredTool,
  type ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import { lspTool, lspToolDef } from "./tools/lsp.js";
import { notebookEditTool, notebookEditToolDef } from "./tools/notebook-edit.js";
import { applyPatchTool, applyPatchToolDef } from "./tools/apply-patch/index.js";
import { parsePatch } from "./tools/apply-patch/parser.js";
import { patchBackupTargets } from "./tools/apply-patch/backup-targets.js";
import {
  enterWorktreeTool,
  enterWorktreeToolDef,
  exitWorktreeTool,
  exitWorktreeToolDef,
  switchSessionWorkspaceTool,
  switchSessionWorkspaceToolDef,
} from "./tools/worktree.js";
import { branchExists, isGitWorktreeRoot } from "./git/worktree.js";
import { checkQuotaTool, checkQuotaToolDef } from "./tools/check-quota.js";
import {
  DRIVE_AGENT_TOOL_TIMEOUT_MS,
  driveAgentJobsTool,
  driveAgentJobsToolDef,
  driveAgentTool,
  driveAgentToolDef,
  driveClaudeCodeTool,
  driveClaudeCodeToolDef,
} from "./tools/drive-agent.js";
import {
  codingArtifactDetector,
  createCodingToolService,
  findCodingInstructionBoundary,
  gitDynamicContextProvider,
} from "./capability-runtime.js";

function defineTool(
  definition: RegisteredTool,
  execute: BuiltinTool["execute"],
  exposure: BuiltinTool["exposure"],
): BuiltinTool {
  return { definition, execute, exposure };
}

const unavailableInQuickChat = (context: ToolVisibilityContext): boolean =>
  context.behaviorProfile !== "quickChatRestricted";

export const CODING_TOOLS: readonly BuiltinTool[] = [
  // `briefTool` remains a root compatibility export, but is deliberately not
  // model-exposed here: its Markdown return value is a tool result, not a
  // user-facing assistant message (especially important for headless runs).
  defineTool(
    {
      ...driveAgentToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      timeoutMs: DRIVE_AGENT_TOOL_TIMEOUT_MS,
      pathPolicy: [
        { kind: "arg", arg: "attachmentPaths", operation: "read" },
        { kind: "arg", arg: "additionalReadDirs", operation: "read" },
      ],
    },
    driveAgentTool,
    { presetTags: ["general", "terminal-coding"], availability: unavailableInQuickChat },
  ),
  defineTool(
    {
      ...driveAgentJobsToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    driveAgentJobsTool,
    { presetTags: ["general", "terminal-coding"], availability: unavailableInQuickChat },
  ),
  defineTool(
    {
      ...driveClaudeCodeToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      timeoutMs: DRIVE_AGENT_TOOL_TIMEOUT_MS,
      pathPolicy: [
        { kind: "arg", arg: "attachmentPaths", operation: "read" },
        { kind: "arg", arg: "additionalReadDirs", operation: "read" },
      ],
    },
    driveClaudeCodeTool,
    { presetTags: ["general", "terminal-coding"], availability: unavailableInQuickChat },
  ),
  defineTool(
    {
      ...checkQuotaToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    checkQuotaTool,
    {
      presetTags: ["terminal-coding"],
      defaultPermissionRules: [{ tool: "CheckQuota", decision: "allow" }],
    },
  ),
  defineTool(
    {
      ...enterWorktreeToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    enterWorktreeTool,
    { presetTags: ["terminal-coding"] },
  ),
  defineTool(
    {
      ...exitWorktreeToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    exitWorktreeTool,
    { presetTags: ["terminal-coding"] },
  ),
  defineTool(
    {
      ...switchSessionWorkspaceToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    switchSessionWorkspaceTool,
    { presetTags: [] },
  ),
  defineTool(
    {
      ...applyPatchToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      pathResolver: {
        operation: "write",
        resolve: (args, cwd) => {
          const patch = typeof args.patch === "string" ? args.patch : "";
          if (!patch) return [];
          const parsed = parsePatch(patch, "lenient");
          return parsed.hunks.flatMap((hunk) => [
            resolve(cwd, hunk.path),
            ...(hunk.kind === "update" && hunk.movePath ? [resolve(cwd, hunk.movePath)] : []),
          ]);
        },
      },
    },
    applyPatchTool,
    { presetTags: ["terminal-coding"] },
  ),
  defineTool(
    {
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
    notebookEditTool,
    { presetTags: ["terminal-coding"] },
  ),
  defineTool(
    {
      ...lspToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
      pathPolicy: [{ kind: "arg", arg: "file_path", operation: "read" }],
    },
    lspTool,
    {
      presetTags: ["terminal-coding"],
      defaultPermissionRules: [{ tool: "LSP", decision: "allow" }],
    },
  ),
];

const generalBase = BUILTIN_AGENT_PRESETS.general;
const generalCodingExposure = derivePresetExposure("general", CODING_TOOLS);
const terminalCodingExposure = derivePresetExposure("terminal-coding", CODING_TOOLS);
const productFullExposure = derivePresetExposure("product-full", BUILTIN_TOOLS);

function codingInitialToolRouting(
  terminal: boolean,
): NonNullable<AgentPreset["initialToolRouting"]> {
  const base = generalBase.initialToolRouting!;
  const rules = [
    {
      id: "coding",
      terms: [
        "code",
        "coding",
        "implement",
        "debug",
        "bug",
        "fix",
        "test",
        "tests",
        "refactor",
        "repository",
        "repo",
        "git",
        "commit",
        "patch",
        "lsp",
        "terminal",
        "shell",
        "python",
        "edit file",
        "modify file",
        "编程",
        "代码",
        "实现",
        "修复",
        "测试",
        "重构",
        "仓库",
        "补丁",
        "修改文件",
        "编辑文件",
        "改配置",
        "报错",
      ],
      toolNames: terminal
        ? ["ApplyPatch", "Bash", "Read", "Grep", "LSP", "Glob", "Edit", "NotebookEdit"]
        : ["Bash", "Read", "Grep", "Glob", "Edit", "DriveAgent", "DriveAgentJobs"],
    },
    {
      id: "worktree",
      terms: ["worktree", "branch", "工作树", "分支"],
      toolNames: ["Bash", "EnterWorktree", "ExitWorktree", "SwitchSessionWorkspace"],
    },
    ...base.rules.map((rule) =>
      terminal && rule.id === "files"
        ? { ...rule, toolNames: ["Read", "Glob", "Grep", "view_image"] }
        : rule,
    ),
  ];
  return {
    ...base,
    // Terminal-coding keeps its ApplyPatch policy. Generic file intent must not
    // bring Write back, including when it is matched alongside another route.
    managedToolNames: [
      ...new Set([
        ...base.managedToolNames.filter((name) => !terminal || name !== "Write"),
        "ApplyPatch",
        ...rules.flatMap((rule) => rule.toolNames),
      ]),
    ].filter((name) => !terminal || name !== "Write"),
    rules: rules.map((rule) => ({
      ...rule,
      toolNames: terminal ? rule.toolNames.filter((name) => name !== "Write") : rule.toolNames,
    })),
  };
}

/** Preserve the general host profile while adding coding-package tools tagged for it. */
export const CODING_GENERAL_PRESET: AgentPreset = {
  ...generalBase,
  initialToolRouting: codingInitialToolRouting(false),
  builtinTools: [...generalBase.builtinTools, ...generalCodingExposure.builtinTools],
  defaultPermissionRules: [
    ...generalBase.defaultPermissionRules,
    ...generalCodingExposure.defaultPermissionRules,
  ],
};

/** Full coding preset assembled from the core baseline plus this package's tools. */
export const TERMINAL_CODING_PRESET: AgentPreset = {
  name: "terminal-coding",
  label: "Terminal Coding Assistant",
  description: "General orchestration plus coding-focused guidance and code-navigation tools.",
  promptSections: ["base", "orchestration", "coding", "browser", "tone"],
  initialToolNames: [
    ...(generalBase.initialToolNames ?? []).filter((name) => name !== "Write"),
    "ApplyPatch",
  ],
  initialToolRouting: codingInitialToolRouting(true),
  builtinTools: [
    ...generalBase.builtinTools,
    ...productFullExposure.builtinTools,
    ...terminalCodingExposure.builtinTools,
  ],
  defaultPermissionRules: [
    ...generalBase.defaultPermissionRules,
    ...productFullExposure.defaultPermissionRules,
    ...terminalCodingExposure.defaultPermissionRules,
  ],
};

const CODING_PROMPT_SECTIONS = {
  coding: readFileSync(new URL("./prompt/coding.md", import.meta.url), "utf-8"),
} as const;

const CODING_FILE_HISTORY = [
  {
    toolName: "ApplyPatch",
    resolveTargets: (args: Record<string, unknown>, cwd: string) =>
      typeof args.patch === "string" ? patchBackupTargets(args.patch, cwd) : [],
  },
] as const;

const CODING_SESSION_WORKSPACE = {
  validateRoot: (root: string) => isGitWorktreeRoot(root),
  branchExists: (mainRoot: string, branch: string) => branchExists(mainRoot, branch),
} as const;

function codingAdjustToolSelection(names: Set<string>, context: { host?: string }): void {
  if (context.host !== "desktop") return;
  names.delete("EnterWorktree");
  names.delete("ExitWorktree");
  names.add("SwitchSessionWorkspace");
}

/** The coding product as a unified AgentModule. */
export function createCodingModule(): AgentModule {
  return {
    id: "coding",
    engine: {
      tools: CODING_TOOLS.map((tool) => ({ kind: "preset-tags" as const, tool })),
      presets: [CODING_GENERAL_PRESET, TERMINAL_CODING_PRESET],
      defaultPreset: "terminal-coding",
      promptSections: CODING_PROMPT_SECTIONS,
      dynamicContextProviders: [gitDynamicContextProvider],
      instructionBoundary: findCodingInstructionBoundary,
      privateService: { scope: "engine", create: createCodingToolService },
      artifactDetectors: [codingArtifactDetector],
      fileHistory: CODING_FILE_HISTORY,
      sessionWorkspace: CODING_SESSION_WORKSPACE,
      adjustToolSelection: codingAdjustToolSelection,
    },
  };
}
