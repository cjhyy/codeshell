import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { encodeCwd } from "./session-discovery.js";
import { findCodexRolloutFile } from "./codex-session-history.js";
import { logger } from "@cjhyy/code-shell-core/extension";

/**
 * #6 — attribute file changes made by a background external agent (DriveAgent
 * running `claude` / `codex`). Those Edit/Write calls land in the external CLI's
 * own transcript, invisible to the host's in-session file-change aggregator.
 * Given the external session id + cwd, locate that transcript and extract the
 * set of changed files, so the UI can show "N files edited" for the run.
 *
 * Read-only; tolerant — a malformed line is skipped, a missing transcript
 * returns []. Never throws for the caller.
 */

const CLAUDE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const CODEX_WRITE_TOOLS = new Set(["apply_patch", "ApplyPatch", "write_file", "edit_file"]);

/** Pull the changed-file path out of a claude tool_use input block. */
function claudeInputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const p = o.file_path ?? o.notebook_path;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

/**
 * Parse claude transcript JSONL text → deduped list of changed file paths.
 * Each line is `{ message: { content: [{ type:"tool_use", name, input }] } }`.
 * Exported for direct unit testing without a transcript file on disk.
 */
export function extractChangedFilesFromClaudeLines(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (d as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_use" &&
        CLAUDE_WRITE_TOOLS.has((block as { name?: string }).name ?? "")
      ) {
        const p = claudeInputPath((block as { input?: unknown }).input);
        if (p) seen.add(p);
      }
    }
  }
  return [...seen];
}

/** Locate `<claudeHome>/projects/<encodeCwd(cwd)>/<sid>.jsonl` and extract changes. */
export function readClaudeChangedFiles(
  cwd: string,
  sessionId: string,
  claudeHome = join(homedir(), ".claude"),
): string[] {
  const file = join(claudeHome, "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  return extractChangedFilesFromClaudeLines(text);
}

/**
 * Parse codex rollout JSONL text → changed file paths. Codex tool calls are
 * `{type:"response_item", payload:{type:"function_call", name, arguments}}` or
 * `{...custom_tool_call, input}`. apply_patch carries the patch text; write/edit
 * carry a file path in arguments. Exported for unit testing.
 */
export function extractChangedFilesFromCodexLines(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d: { type?: string; payload?: Record<string, unknown> } | undefined;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.type !== "response_item" || !d.payload) continue;
    const p = d.payload;
    const name = typeof p.name === "string" ? p.name : "";
    if (!CODEX_WRITE_TOOLS.has(name)) continue;
    // function_call.arguments is a JSON string; custom_tool_call.input a string.
    const rawArgs =
      typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : "";
    for (const f of filesFromCodexArgs(name, rawArgs)) seen.add(f);
  }
  return [...seen];
}

/** Pull file paths out of a codex tool's arguments string. */
function filesFromCodexArgs(name: string, raw: string): string[] {
  if (!raw) return [];
  if (name === "apply_patch" || name === "ApplyPatch") {
    // apply_patch payload wraps a patch; headers look like `*** Update File: <p>`
    // or `*** Add File: <p>`, and a rename follows Update with `*** Move to: <p>`.
    // Match those directly off the raw text so a rename keeps both paths.
    const out: string[] = [];
    const re = /\*\*\*\s+(?:(?:Update|Add|Delete) File|Move to):\s+(.+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const f = m[1]?.trim();
      if (f) out.push(f);
    }
    return out;
  }
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    const p = a.file_path ?? a.path;
    return typeof p === "string" && p ? [p] : [];
  } catch {
    return [];
  }
}

/** Locate a codex rollout by threadId+cwd under `<codexHome>/sessions` and extract changes. */
export function readCodexChangedFiles(
  cwd: string,
  threadId: string,
  codexHome = join(homedir(), ".codex"),
): string[] {
  // Same locator as history/tails: a resumed thread uses its newest rollout.
  const file = findCodexRolloutFile(codexHome, cwd, threadId);
  if (!file) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  return extractChangedFilesFromCodexLines(text);
}

/** Dispatch by CLI. Unknown cli → []. Never throws. */
export function readExternalChangedFiles(cli: string, cwd: string, sessionId: string): string[] {
  try {
    const files =
      cli === "codex"
        ? readCodexChangedFiles(cwd, sessionId)
        : readClaudeChangedFiles(cwd, sessionId);
    logger.debug("changed_files.external.extracted", {
      cat: "changed_files",
      cli,
      cwd,
      externalSessionId: sessionId,
      size: files.length,
      files,
    });
    return files;
  } catch (err) {
    logger.debug("changed_files.external.extract_failed", {
      cat: "changed_files",
      cli,
      cwd,
      externalSessionId: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
