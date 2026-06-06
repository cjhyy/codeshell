import type { ExternalAgentKind, ExternalAgentModeOverride } from "./types.js";

export interface ParsedExternalAgentSlash {
  kind: ExternalAgentKind;
  prompt: string;
  mode: ExternalAgentModeOverride;
}

export function parseExternalAgentSlash(input: string): ParsedExternalAgentSlash | undefined {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/(cc|codex)\s+(.+)$/s);
  if (!match) return undefined;
  const kind: ExternalAgentKind = match[1] === "cc" ? "claude-code" : "codex";
  let body = match[2]!.trim();
  let mode: ExternalAgentModeOverride;
  if (body.startsWith("--safe ")) {
    mode = "safe";
    body = body.slice("--safe ".length).trim();
  } else if (body.startsWith("--dangerous ")) {
    mode = "dangerous";
    body = body.slice("--dangerous ".length).trim();
  }
  if (!body) return undefined;
  return { kind, prompt: body, mode };
}
