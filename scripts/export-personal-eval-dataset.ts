#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

type Candidate = {
  state: JsonObject;
  events: JsonObject[];
  fingerprint: string;
  startedAt: number;
};

const SCHEMA_VERSION = 1;

const FIRST_PARTY_TOOLS = new Set([
  "AddMarketplace",
  "Agent",
  "AgentCancel",
  "AgentSendInput",
  "AgentStatus",
  "ApplyPatch",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "Browser",
  "CheckQuota",
  "ConfigureModelConnection",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DriveAgent",
  "DriveAgentJobs",
  "DriveClaudeCode",
  "Edit",
  "EditModelCatalog",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "GenerateImage",
  "GenerateVideo",
  "Glob",
  "Grep",
  "InstallCapability",
  "KillShell",
  "LSP",
  "ListMcpResources",
  "ListShells",
  "ListSources",
  "MemoryDelete",
  "MemoryList",
  "MemoryRead",
  "MemorySave",
  "NotebookEdit",
  "Panel",
  "PowerShell",
  "Read",
  "ReadFile",
  "ReadMcpResource",
  "ReadSource",
  "SendMessage",
  "Skill",
  "Sleep",
  "SwitchSessionWorkspace",
  "TodoWrite",
  "ToolSearch",
  "UpdateAutomationMemory",
  "WebFetch",
  "WebSearch",
  "Write",
  "apply_patch",
  "browser_act",
  "browser_navigate",
  "browser_observe",
  "exec_command",
  "view_image",
]);

const ALLOWED_EVENT_TYPES = new Set([
  "message",
  "tool_use",
  "tool_result",
  "summary",
  "context_transfer",
  "range_archive",
  "content_replace",
  "file_history",
  "plan_operation",
  "session_meta",
  "subagent",
  "external_file_changes",
  "turn_boundary",
  "run_result",
  "goal_progress",
  "turn_stopped",
  "error",
]);

const SAFE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const SAFE_BLOCK_TYPES = new Set(["text", "tool_use", "tool_result", "image", "reasoning"]);
const SAFE_TERMINAL_STATUSES = new Set([
  "completed",
  "model_error",
  "max_turns",
  "prompt_too_long",
  "goal_budget_exhausted",
  "aborted_streaming",
]);

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  const number = finiteNumber(value);
  return number === null ? 0 : Math.max(0, Math.floor(number));
}

function parseJsonLines(filePath: string): JsonObject[] {
  const events: JsonObject[] = [];
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as JsonObject);
      }
    } catch {
      // A torn or malformed line is excluded rather than copied into the export.
    }
  }
  return events;
}

function fingerprint(value: string): string {
  return createHash("sha256")
    .update(`codeshell-personal-eval-v1:${value}`)
    .digest("hex")
    .slice(0, 16);
}

function isSelectedState(state: JsonObject): boolean {
  const origin = state.origin;
  const status = state.status;
  return (
    (origin === "desktop" || origin === "tui") &&
    (status === "completed" || status === "model_error") &&
    typeof state.title === "string" &&
    state.title.length > 0 &&
    nonNegativeInteger(state.turnCount) > 0 &&
    (state.parentSessionId === null || state.parentSessionId === undefined)
  );
}

function isRealUserMessage(event: JsonObject): boolean {
  if (event.type !== "message") return false;
  const data = asObject(event.data);
  return data.role === "user" && data.injected !== true;
}

function isAssistantMessage(event: JsonObject): boolean {
  return event.type === "message" && asObject(event.data).role === "assistant";
}

function loadCandidates(sourceDir: string): Candidate[] {
  if (!existsSync(sourceDir)) throw new Error("CodeShell session directory was not found");

  const candidates: Candidate[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = join(sourceDir, entry.name, "state.json");
    const transcriptPath = join(sourceDir, entry.name, "transcript.jsonl");
    if (!existsSync(statePath) || !existsSync(transcriptPath)) continue;

    let state: JsonObject;
    try {
      state = asObject(JSON.parse(readFileSync(statePath, "utf8")));
    } catch {
      continue;
    }
    if (!isSelectedState(state)) continue;

    const events = parseJsonLines(transcriptPath);
    if (!events.some(isRealUserMessage) || !events.some(isAssistantMessage)) continue;

    const sourceId = typeof state.sessionId === "string" ? state.sessionId : entry.name;
    candidates.push({
      state,
      events,
      fingerprint: fingerprint(sourceId),
      startedAt: finiteNumber(state.startedAt) ?? 0,
    });
  }

  return candidates.sort(
    (a, b) => a.startedAt - b.startedAt || a.fingerprint.localeCompare(b.fingerprint),
  );
}

function providerFamily(value: unknown): string {
  const provider = typeof value === "string" ? value.toLowerCase() : "";
  if (provider.includes("openai") || provider.includes("codex")) return "openai";
  if (provider.includes("anthropic")) return "anthropic";
  if (provider.includes("openrouter")) return "openrouter";
  if (provider.includes("deepseek")) return "deepseek";
  if (provider.includes("google") || provider.includes("gemini")) return "google";
  if (provider.includes("azure")) return "azure";
  if (provider.includes("bedrock")) return "bedrock";
  if (provider.includes("ollama") || provider.includes("local")) return "local";
  return "other";
}

function modelFamily(value: unknown): string {
  const model = typeof value === "string" ? value.toLowerCase() : "";
  if (/\b(claude|anthropic)\b/.test(model)) return "anthropic";
  if (/\b(gpt|openai|codex|o[134](?:-|\b))/.test(model)) return "openai";
  if (model.includes("deepseek")) return "deepseek";
  if (model.includes("gemini")) return "google";
  if (model.includes("qwen")) return "qwen";
  if (model.includes("glm")) return "glm";
  if (model.includes("llama")) return "llama";
  return "other";
}

function textLength(value: unknown, depth = 0): number {
  if (depth > 8 || value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + textLength(item, depth + 1), 0);
  if (typeof value === "object") {
    return Object.values(value as JsonObject).reduce(
      (sum, item) => sum + textLength(item, depth + 1),
      0,
    );
  }
  return 0;
}

function sizeBucket(size: number): string {
  if (size === 0) return "0";
  if (size <= 50) return "1-50";
  if (size <= 200) return "51-200";
  if (size <= 1_000) return "201-1000";
  if (size <= 5_000) return "1001-5000";
  if (size <= 20_000) return "5001-20000";
  return "20000+";
}

function splitFor(sourceFingerprint: string): "dev" | "regression" | "holdout" {
  const bucket = Number.parseInt(sourceFingerprint.slice(0, 2), 16);
  if (bucket < 154) return "dev";
  if (bucket < 205) return "regression";
  return "holdout";
}

function eventToolName(event: JsonObject): string | undefined {
  const value = asObject(event.data).toolName;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectExternalToolAliases(candidates: Candidate[]): Map<string, string> {
  const names = new Set<string>();
  for (const candidate of candidates) {
    for (const event of candidate.events) {
      const name = eventToolName(event);
      if (name && !FIRST_PARTY_TOOLS.has(name)) names.add(name);
    }
  }

  return new Map(
    [...names]
      .sort()
      .map((name, index) => [name, `external_tool_${String(index + 1).padStart(2, "0")}`]),
  );
}

function toolAlias(name: string | undefined, externalAliases: Map<string, string>): string {
  if (!name) return "unknown_tool";
  if (FIRST_PARTY_TOOLS.has(name)) return name;
  return externalAliases.get(name) ?? "external_tool";
}

function taskCategory(tools: Set<string>): string {
  const has = (...names: string[]) => names.some((name) => tools.has(name));
  if (has("GenerateImage", "GenerateVideo")) return "media";
  if (has("CronCreate", "CronDelete", "CronList", "UpdateAutomationMemory")) return "automation";
  if (
    has("Agent", "AgentCancel", "AgentSendInput", "AgentStatus", "DriveAgent", "DriveAgentJobs")
  ) {
    return "orchestration";
  }
  if (has("MemoryDelete", "MemoryList", "MemoryRead", "MemorySave")) return "memory";
  if (has("WebFetch", "WebSearch", "Browser", "ReadMcpResource", "ListMcpResources")) {
    return "research";
  }
  if (has("ApplyPatch", "Bash", "Edit", "Glob", "Grep", "LSP", "PowerShell", "Read", "Write")) {
    return "coding";
  }
  return "general";
}

function blockTypeCounts(content: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(content)) return counts;
  for (const block of content) {
    const rawType = asObject(block).type;
    const type = typeof rawType === "string" && SAFE_BLOCK_TYPES.has(rawType) ? rawType : "other";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function safeTerminalStatus(value: unknown): string {
  return typeof value === "string" && SAFE_TERMINAL_STATUSES.has(value) ? value : "other";
}

function sanitizeEvent(
  event: JsonObject,
  eventIndex: number,
  firstTimestamp: number,
  externalAliases: Map<string, string>,
): JsonObject {
  const rawType = event.type;
  const type = typeof rawType === "string" && ALLOWED_EVENT_TYPES.has(rawType) ? rawType : "other";
  const data = asObject(event.data);
  const timestamp = finiteNumber(event.timestamp) ?? firstTimestamp;
  const base: JsonObject = {
    schemaVersion: SCHEMA_VERSION,
    eventIndex,
    type,
    turnNumber: nonNegativeInteger(event.turnNumber),
    offsetMs: Math.max(0, Math.round((timestamp - firstTimestamp) / 100) * 100),
  };

  if (type === "message") {
    const role = typeof data.role === "string" && SAFE_ROLES.has(data.role) ? data.role : "other";
    return {
      ...base,
      role,
      injected: data.injected === true,
      payloadSize: sizeBucket(textLength(data.content)),
      blockTypes: blockTypeCounts(data.content),
    };
  }

  if (type === "tool_use") {
    return {
      ...base,
      tool: toolAlias(eventToolName(event), externalAliases),
      argumentFieldCount: Object.keys(asObject(data.args)).length,
    };
  }

  if (type === "tool_result") {
    const failed =
      typeof data.error === "string" || data.isError === true || data.is_error === true;
    return {
      ...base,
      tool: toolAlias(eventToolName(event), externalAliases),
      ok: !failed,
      payloadSize: sizeBucket(
        textLength(data.result) + textLength(data.error) + textLength(data.contentBlocks),
      ),
      contentBlockCount: Array.isArray(data.contentBlocks) ? data.contentBlocks.length : 0,
    };
  }

  if (type === "run_result") {
    const result = asObject(data.result);
    return {
      ...base,
      terminalReason: safeTerminalStatus(result.reason),
      turns: nonNegativeInteger(result.turnCount),
    };
  }

  if (type === "external_file_changes") {
    return {
      ...base,
      changedFileCount: Array.isArray(data.changedFiles) ? data.changedFiles.length : 0,
      succeeded: data.status === "completed" || data.status === "success",
    };
  }

  if (type === "context_transfer") {
    return {
      ...base,
      sourceEventCount: nonNegativeInteger(data.sourceEventCount),
      estimatedTokens: nonNegativeInteger(data.estimatedTokens),
    };
  }

  if (type === "range_archive") {
    return { ...base, summarySize: sizeBucket(textLength(data.summary)) };
  }

  if (type === "goal_progress") {
    return {
      ...base,
      round: nonNegativeInteger(data.round),
      gapCount: Array.isArray(data.gaps) ? data.gaps.length : 0,
    };
  }

  return base;
}

function tokenMetrics(state: JsonObject): JsonObject {
  const usage = asObject(state.tokenUsage);
  const pick = (key: string): number | null => finiteNumber(usage[key]);
  return {
    prompt: pick("promptTokens"),
    completion: pick("completionTokens"),
    total: pick("totalTokens"),
    cacheRead: pick("cacheReadTokens"),
    cacheCreation: pick("cacheCreationTokens"),
  };
}

function writePrivate(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, filePath);
  if (process.platform !== "win32") chmodSync(filePath, 0o600);
}

const FORBIDDEN_STRING_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "absolute Unix path", pattern: /(?:^|\s)\/(?:Users|home|private|var|tmp)\// },
  { label: "absolute Windows path", pattern: /\b[A-Za-z]:\\/ },
  { label: "email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { label: "URL", pattern: /https?:\/\//i },
  { label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { label: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{12,}/ },
  { label: "GitHub-style token", pattern: /\bgh[pousr]_[A-Za-z0-9]{12,}/i },
  { label: "long opaque secret", pattern: /\b[A-Za-z0-9+/=_-]{48,}\b/ },
];

function auditSanitizedValue(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    for (const { label, pattern } of FORBIDDEN_STRING_PATTERNS) {
      if (pattern.test(value)) throw new Error(`Privacy audit rejected ${label} at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => auditSanitizedValue(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as JsonObject)) {
      auditSanitizedValue(child, `${path}.${key}`);
    }
  }
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

const sourceDir = resolve(flagValue("--source") ?? join(homedir(), ".code-shell", "sessions"));
const outputDir = resolve(
  flagValue("--output") ?? join(process.cwd(), "evals", "personal-sanitized"),
);
const traceDir = join(outputDir, "traces");

ensurePrivateDirectory(outputDir);
ensurePrivateDirectory(traceDir);

const candidates = loadCandidates(sourceDir);
const externalAliases = collectExternalToolAliases(candidates);
const cases: JsonObject[] = [];
const splitCounts = { dev: 0, regression: 0, holdout: 0 };
const statusCounts: Record<string, number> = {};
const originCounts: Record<string, number> = {};

for (const [candidateIndex, candidate] of candidates.entries()) {
  const caseId = `personal-${String(candidateIndex + 1).padStart(4, "0")}`;
  const timestamps = candidate.events
    .map((event) => finiteNumber(event.timestamp))
    .filter((value): value is number => value !== null);
  const firstTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const lastTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : firstTimestamp;
  const sanitizedEvents = candidate.events.map((event, index) =>
    sanitizeEvent(event, index + 1, firstTimestamp, externalAliases),
  );

  sanitizedEvents.forEach((event, index) => auditSanitizedValue(event, `trace[${index}]`));
  writePrivate(
    join(traceDir, `${caseId}.jsonl`),
    sanitizedEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );

  const rawTools = new Set(
    candidate.events.map(eventToolName).filter((name): name is string => typeof name === "string"),
  );
  const aliasedTools = new Set([...rawTools].map((name) => toolAlias(name, externalAliases)));
  const userMessages = candidate.events.filter(isRealUserMessage).length;
  const assistantMessages = candidate.events.filter(isAssistantMessage).length;
  const toolCalls = candidate.events.filter((event) => event.type === "tool_use").length;
  const failedToolResults = candidate.events.filter((event) => {
    if (event.type !== "tool_result") return false;
    const data = asObject(event.data);
    return typeof data.error === "string" || data.isError === true || data.is_error === true;
  }).length;
  const split = splitFor(candidate.fingerprint);
  const status = safeTerminalStatus(candidate.state.status);
  const origin = candidate.state.origin === "tui" ? "tui" : "desktop";
  splitCounts[split] += 1;
  statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  originCounts[origin] = (originCounts[origin] ?? 0) + 1;

  const item: JsonObject = {
    schemaVersion: SCHEMA_VERSION,
    caseId,
    sourceFingerprint: candidate.fingerprint,
    split,
    reviewStatus: "unreviewed",
    origin,
    providerFamily: providerFamily(candidate.state.provider),
    modelFamily: modelFamily(candidate.state.model),
    taskCategory: taskCategory(rawTools),
    outcome: {
      status,
      turnCount: nonNegativeInteger(candidate.state.turnCount),
    },
    metrics: {
      durationMs: Math.max(0, Math.round((lastTimestamp - firstTimestamp) / 1000) * 1000),
      userMessages,
      assistantMessages,
      toolCalls,
      failedToolResults,
      subagents: candidate.events.filter((event) => event.type === "subagent").length,
      compactions: candidate.events.filter(
        (event) =>
          event.type === "summary" ||
          event.type === "context_transfer" ||
          event.type === "range_archive",
      ).length,
      invokedSkillCount: Array.isArray(candidate.state.invokedSkills)
        ? candidate.state.invokedSkills.length
        : 0,
      tokens: tokenMetrics(candidate.state),
    },
    distinctTools: [...aliasedTools].sort(),
    traceFile: `traces/${caseId}.jsonl`,
    privacy: {
      freeFormTextRetained: false,
      absolutePathsRetained: false,
      absoluteTimestampsRetained: false,
      rawIdentifiersRetained: false,
      toolArgumentsRetained: false,
      toolOutputsRetained: false,
    },
  };
  auditSanitizedValue(item, `case[${candidateIndex}]`);
  cases.push(item);
}

const manifest: JsonObject = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  source: "$HOME/.code-shell/sessions",
  selectedCases: cases.length,
  splits: splitCounts,
  statuses: statusCounts,
  origins: originCounts,
  externalToolAliases: externalAliases.size,
  selection: {
    interactiveOriginsOnly: true,
    topLevelOnly: true,
    titledOnly: true,
    terminalStatuses: ["completed", "model_error"],
    requiresUserAndAssistantMessages: true,
  },
  privacy: {
    freeFormTextRetained: false,
    absolutePathsRetained: false,
    absoluteTimestampsRetained: false,
    rawIdentifiersRetained: false,
    toolArgumentsRetained: false,
    toolOutputsRetained: false,
    externalToolNamesPseudonymized: true,
  },
};

auditSanitizedValue(manifest, "manifest");
writePrivate(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writePrivate(
  join(outputDir, "cases.jsonl"),
  cases.map((item) => JSON.stringify(item)).join("\n") + "\n",
);

process.stdout.write(
  `Exported ${cases.length} privacy-filtered cases to ${outputDir}\n` +
    `Splits: dev=${splitCounts.dev}, regression=${splitCounts.regression}, holdout=${splitCounts.holdout}\n`,
);
