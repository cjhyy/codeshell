/**
 * Summarise the currently-streaming turn for the TopBar status
 * popover. Runs on every render of App while busy, so it has to be
 * cheap — single pass from the end of the messages array, no
 * allocations beyond the returned object.
 *
 * The "current turn" is everything after the most recent UserMessage.
 * If the user hasn't sent anything yet (no UserMessage in history),
 * we walk the whole array — that's the initial system prompt / boot
 * tool calls case.
 */

import type { Message, ToolMessage } from "../types";
import { parsedArgs, basename, truncate } from "../tool-cards/utils";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";

export interface LiveActivity {
  /** Name of the most recent in-flight tool, or the last completed
   *  tool if nothing is in-flight. Empty string while there are no
   *  tools yet (e.g. assistant is just thinking). */
  lastToolName: string;
  /** The most relevant tool message this turn (running tool if any,
   *  else the last completed). Null while the assistant is only
   *  thinking. Lets consumers extract live args (command, file…). */
  lastTool: ToolMessage | null;
  /** Tool calls fired since the most recent user message. */
  toolCount: number;
  /** Earliest tool startedAt in this turn — drives the elapsed
   *  ticker. 0 means no tools yet; consumers should fall back to
   *  the user message timestamp or "just started" copy. */
  turnStartedAt: number;
  /** True while there's a tool in-flight (status === "running"). */
  toolInFlight: boolean;
}

export function summarizeLiveActivity(messages: Message[]): LiveActivity {
  // Walk backward to find the last user message; anything after it
  // is the current turn.
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.kind === "user") {
      turnStart = i + 1;
      break;
    }
  }

  let toolCount = 0;
  let earliestStart = Infinity;
  let lastTool: ToolMessage | null = null;
  let runningTool: ToolMessage | null = null;

  for (let i = turnStart; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.kind !== "tool") continue;
    toolCount += 1;
    if (m.startedAt < earliestStart) earliestStart = m.startedAt;
    lastTool = m;
    if (m.status === "running") runningTool = m;
  }

  const primary = runningTool ?? lastTool;
  return {
    lastToolName: primary?.toolName ?? "",
    lastTool: primary,
    toolCount,
    turnStartedAt: isFinite(earliestStart) ? earliestStart : 0,
    toolInFlight: runningTool !== null,
  };
}

/**
 * Same shape as summarizeLiveActivity but scoped to ONE sub-agent's own
 * toolCalls (which live inside its AgentMessage, not in the top-level feed).
 * Lets a subagent card show its own Codex-style "正在读取 schema.ts" line
 * without scanning the whole conversation. Single pass, no allocations beyond
 * the returned object — runs on every 50ms flush while the agent is live.
 */
export function summarizeAgentActivity(toolCalls: ToolMessage[]): LiveActivity {
  let toolCount = 0;
  let earliestStart = Infinity;
  let lastTool: ToolMessage | null = null;
  let runningTool: ToolMessage | null = null;
  for (const m of toolCalls) {
    toolCount += 1;
    if (m.startedAt < earliestStart) earliestStart = m.startedAt;
    lastTool = m;
    if (m.status === "running") runningTool = m;
  }
  const primary = runningTool ?? lastTool;
  return {
    lastToolName: primary?.toolName ?? "",
    lastTool: primary,
    toolCount,
    turnStartedAt: isFinite(earliestStart) ? earliestStart : 0,
    toolInFlight: runningTool !== null,
  };
}

/**
 * Localized one-line description of what the agent is doing right now, Codex
 * style: a verb + the tool's most telling argument (the bash command, the
 * file being edited, the search pattern…), or "正在思考…" when no tool has
 * fired yet. `running` flips the verb between present ("正在运行") and a
 * neutral past-ish form ("已运行") so a finished-but-not-yet-next-step moment
 * doesn't read as still-in-flight.
 *
 * Args are read via parsedArgs (prefers the live-streaming snapshot), so the
 * line fills in character-by-character as tool_use_args_delta arrives — the
 * same source the tool cards use, no new backend signal needed.
 */
export function describeActivity(activity: LiveActivity): string {
  const lang = loadUILanguage();
  const tr = (key: string): string => translate(lang, key);
  const t = activity.lastTool;
  if (!t) return tr("misc.activity.thinking");
  const a = parsedArgs(t);
  const running = t.status === "running";
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  // Per-tool argument pick. Falls through to a bare verb + tool name.
  let detail = "";
  switch (t.toolName) {
    case "Bash":
      detail = str(a.command);
      break;
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit": {
      const fp = str(a.file_path) || str(a.notebook_path);
      detail = fp ? basename(fp) : "";
      break;
    }
    case "Grep":
    case "Glob":
      detail = str(a.pattern);
      break;
    case "Skill":
      detail = str(a.skill);
      break;
    case "Agent":
      detail = str(a.name) || str(a.description);
      break;
    case "WebFetch":
      detail = str(a.url);
      break;
    case "WebSearch":
      detail = str(a.query);
      break;
    default:
      detail = "";
  }

  const verbs: Record<string, [string, string]> = {
    Bash: [tr("misc.activity.running"), tr("misc.activity.ranPast")],
    Edit: [tr("misc.activity.editing"), tr("misc.activity.editedPast")],
    Write: [tr("misc.activity.writing"), tr("misc.activity.wrotePast")],
    Read: [tr("misc.activity.reading"), tr("misc.activity.readPast")],
    NotebookEdit: [tr("misc.activity.editing"), tr("misc.activity.editedPast")],
    Grep: [tr("misc.activity.searching"), tr("misc.activity.searchedPast")],
    Glob: [tr("misc.activity.finding"), tr("misc.activity.foundPast")],
    Skill: [tr("misc.activity.callingSkill"), tr("misc.activity.calledSkill")],
    Agent: [tr("misc.activity.dispatchingAgent"), tr("misc.activity.dispatchedAgent")],
    WebFetch: [tr("misc.activity.fetching"), tr("misc.activity.fetchedPast")],
    WebSearch: [tr("misc.activity.searching"), tr("misc.activity.searchedPast")],
  };
  const [presentVerb, pastVerb] = verbs[t.toolName] ?? [tr("misc.activity.running"), tr("misc.activity.ranPast")];
  const verb = running ? presentVerb : pastVerb;

  const label = detail ? `${verb} ${truncate(detail.replace(/\s+/g, " ").trim(), 64)}` : `${verb} ${t.toolName}`;
  return label;
}

/** Format an elapsed millisecond delta like the AgentMessageView ticker. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}
