/**
 * Frontmatter parser for SKILL.md files. Byte-compatible with Claude Code's
 * `utils/frontmatterParser.ts` so community skill repositories can be reused
 * without modification.
 */

import { parse as parseYaml } from "yaml";

export const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/;

const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /;

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const text = match[1] ?? "";
  const body = raw.slice(match[0].length);

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    try {
      parsed = parseYaml(quoteProblematicValues(text));
    } catch {
      return { frontmatter: {}, body };
    }
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { frontmatter: parsed as Record<string, unknown>, body };
  }
  return { frontmatter: {}, body };
}

export function quoteProblematicValues(frontmatterText: string): string {
  const lines = frontmatterText.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const m = line.match(/^([a-zA-Z_-]+):\s+(.+)$/);
    if (!m) {
      result.push(line);
      continue;
    }
    const key = m[1];
    const value = m[2];
    if (!key || !value) {
      result.push(line);
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      result.push(line);
      continue;
    }
    if (YAML_SPECIAL_CHARS.test(value)) {
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      result.push(`${key}: "${escaped}"`);
      continue;
    }
    result.push(line);
  }

  return result.join("\n");
}

export function coerceDescription(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
