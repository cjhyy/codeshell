import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { encodeCwd } from "./session-discovery.js";

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  /** `summary` is a lossy one-field preview; `args` is the full tool_use input
   *  (e.g. a sub-agent's `prompt`) so a replayed tool card can show the real
   *  parameters, not just the whitelisted field. */
  tools?: { name: string; summary: string; args?: Record<string, unknown> }[];
  ts?: number;
}

const NOISE = ["<local-command-caveat>", "<command-name>"];
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}
function toolsOf(content: unknown): { name: string; summary: string; args?: Record<string, unknown> }[] {
  if (!Array.isArray(content)) return [];
  const out: { name: string; summary: string; args?: Record<string, unknown> }[] = [];
  for (const p of content as any[]) {
    if (p?.type === "tool_use") {
      const inp = p.input ?? {};
      const summary = inp.command ?? inp.file_path ?? inp.path ?? inp.url ?? inp.pattern ?? inp.query ?? "";
      const args = inp && typeof inp === "object" && Object.keys(inp).length > 0 ? inp : undefined;
      out.push({ name: typeof p.name === "string" ? p.name : "tool", summary: String(summary).slice(0, 120), args });
    }
  }
  return out;
}

/** Read the last `limit` user/assistant messages from a claude session jsonl. */
export function readRecentHistory(
  cwd: string,
  sessionId: string,
  limit: number,
  claudeHome = join(homedir(), ".claude"),
): { messages: HistoryMessage[]; hasMore: boolean; totalCount: number } {
  const file = join(claudeHome, "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
  if (!existsSync(file)) return { messages: [], hasMore: false, totalCount: 0 };
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch { return { messages: [], hasMore: false, totalCount: 0 }; }
  const all: HistoryMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "user") {
      const t = textOf(d.message?.content).trim();
      if (!t || NOISE.some((n) => t.startsWith(n))) continue;
      all.push({ role: "user", text: t });
    } else if (d.type === "assistant") {
      const t = textOf(d.message?.content).trim();
      const tools = toolsOf(d.message?.content);
      if (!t && tools.length === 0) continue;
      all.push({ role: "assistant", text: t, tools: tools.length ? tools : undefined });
    }
  }
  const lim = limit > 0 ? limit : 20;
  const start = Math.max(0, all.length - lim);
  return { messages: all.slice(start), hasMore: start > 0, totalCount: all.length };
}
