import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Encode a cwd to claude's project dir name: every non-[A-Za-z0-9] char → '-'.
 *  Mirrors `~/.claude/projects/<encoded>` (verified against real layout). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export interface DiscoveredSession {
  sessionId: string;
  firstMessage: string;
  lastModified: number;
  messageCount: number;
}

function claudeProjectsDir(claudeHome: string): string {
  return join(claudeHome, "projects");
}

/** Extract first *real* user message text, skipping caveat/command noise. */
function firstUserMessage(lines: string[]): string {
  for (const line of lines) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "user") continue;
    const c = d.message?.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
        : "";
    const t = text.trim();
    if (!t) continue;
    if (t.startsWith("<local-command-caveat>") || t.startsWith("<command-name>")) continue;
    return t.slice(0, 200);
  }
  return "";
}

function countUserMessages(lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { if (JSON.parse(line).type === "user") n++; } catch { /* skip */ }
  }
  return n;
}

/** List claude sessions for `cwd`. `claudeHome` defaults to ~/.claude (override
 *  for tests). Read-only, on-demand scan; no index. */
export function discoverSessions(cwd: string, claudeHome = join(homedir(), ".claude")): DiscoveredSession[] {
  const dir = join(claudeProjectsDir(claudeHome), encodeCwd(cwd));
  if (!existsSync(dir)) return [];
  const out: DiscoveredSession[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    let st;
    try { st = statSync(file); } catch { continue; }
    let lines: string[];
    try { lines = readFileSync(file, "utf-8").split("\n"); } catch { continue; }
    out.push({
      sessionId: name.replace(/\.jsonl$/, ""),
      firstMessage: firstUserMessage(lines),
      lastModified: st.mtimeMs,
      messageCount: countUserMessages(lines),
    });
  }
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out;
}
