/**
 * Markdown renderer for `/export markdown`.
 *
 * Goals (versus the legacy one-JSON-line-per-turn dump):
 *   • Every turn is numbered and role-tagged
 *   • Reasoning blocks are collapsible (<details>) — present but not noisy
 *   • tool_use shows tool name + truncated args inline
 *   • tool_result over a threshold spills to a sidecar file alongside the md
 *   • Long lines never exceed ~2 KB inline so editors stay responsive
 */

import { join, basename } from "node:path";

const INLINE_RESULT_LIMIT = 2_000;
const INLINE_ARG_LIMIT = 800;

export interface Sidecar {
  path: string;
  content: string;
}

export interface RenderedSession {
  md: string;
  sidecars: Sidecar[];
}

interface ContentItem {
  type: string;
  text?: string;
  reasoningContent?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  id?: string;
}

// sessionId is interpolated into a directory path; reject anything that
// could break out of the export root (path separators, parent refs, NULs).
const SAFE_SID_RE = /^[A-Za-z0-9_-]+$/;

export function renderSessionMarkdown(
  sessionId: string,
  events: unknown[],
  cwd: string,
): RenderedSession {
  if (!SAFE_SID_RE.test(sessionId)) {
    throw new Error(
      `renderSessionMarkdown: invalid sessionId ${JSON.stringify(sessionId)} — expected [A-Za-z0-9_-]+`,
    );
  }
  const lines: string[] = [];
  const sidecars: Sidecar[] = [];
  const sidecarDir = `session-${sessionId}-attachments`;

  lines.push(`# Session ${sessionId}`);
  lines.push("");

  let turnNumber = 0;
  for (const evRaw of events) {
    const ev = evRaw as { type?: string; data?: { role?: string; content?: unknown } };
    if (ev.type !== "message") continue;
    turnNumber += 1;
    const role = ev.data?.role ?? "unknown";
    const content = ev.data?.content;

    lines.push(`## turn ${turnNumber} · ${role}`);
    lines.push("");

    if (typeof content === "string") {
      lines.push(content);
      lines.push("");
      continue;
    }

    if (!Array.isArray(content)) {
      lines.push("```json");
      lines.push(JSON.stringify(content, null, 2));
      lines.push("```");
      lines.push("");
      continue;
    }

    let itemIdx = 0;
    for (const itemRaw of content as ContentItem[]) {
      itemIdx += 1;
      const block = renderBlock(itemRaw, {
        turnNumber,
        itemIdx,
        sidecarDir,
        cwd,
        sidecars,
      });
      if (block) {
        lines.push(block);
        lines.push("");
      }
    }
  }

  return { md: lines.join("\n"), sidecars };
}

interface RenderCtx {
  turnNumber: number;
  itemIdx: number;
  sidecarDir: string;
  cwd: string;
  sidecars: Sidecar[];
}

function renderBlock(item: ContentItem, rctx: RenderCtx): string {
  const t = item.type;
  if (t === "reasoning") {
    const txt = item.reasoningContent ?? "";
    return collapsible("reasoning", txt);
  }
  if (t === "text") {
    return item.text ?? "";
  }
  if (t === "tool_use") {
    const name = item.name ?? "?";
    const argsJson = JSON.stringify(item.input ?? {}, null, 2) ?? "{}";
    const head = `**🛠 tool_use** · \`${name}\``;
    if (argsJson.length <= INLINE_ARG_LIMIT) {
      return `${head}\n\n\`\`\`json\n${argsJson}\n\`\`\``;
    }
    return collapsible(`${name} args (${argsJson.length} bytes)`, argsJson, "json");
  }
  if (t === "tool_result") {
    const toolUseId = item.tool_use_id ?? item.id ?? "?";
    const raw = stringifyResult(item.content);
    if (raw.length <= INLINE_RESULT_LIMIT) {
      return `**◀ tool_result** · ${toolUseId}\n\n\`\`\`\n${raw}\n\`\`\``;
    }
    const sidecarName = `t${rctx.turnNumber}-i${rctx.itemIdx}-${toolUseId.slice(0, 12)}.txt`;
    const sidecarPath = join(rctx.cwd, rctx.sidecarDir, sidecarName);
    rctx.sidecars.push({ path: sidecarPath, content: raw });
    const preview = raw.slice(0, INLINE_RESULT_LIMIT);
    const rel = join(rctx.sidecarDir, basename(sidecarPath));
    return (
      `**◀ tool_result** · ${toolUseId} · ${raw.length.toLocaleString()} bytes · ` +
      `[full → ${rel}](./${rel})\n\n` +
      `\`\`\`\n${preview}\n…(truncated, see sidecar)\n\`\`\``
    );
  }
  return "```json\n" + JSON.stringify(item, null, 2) + "\n```";
}

function collapsible(summary: string, body: string, lang = ""): string {
  const fence = lang ? "```" + lang : "```";
  return `<details><summary>${summary}</summary>\n\n${fence}\n${body}\n\`\`\`\n\n</details>`;
}

function stringifyResult(c: unknown): string {
  if (c === null || c === undefined) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const part of c as Array<{ type?: string; text?: string }>) {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        parts.push(part.text);
      } else {
        parts.push(JSON.stringify(part));
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(c, null, 2);
}
