import { realpathSync } from "node:fs";
import * as path from "node:path";

/**
 * Guard for renderer-supplied file paths handed to readSkillBody/readAgentBody.
 *
 * Those handlers fs.readFile whatever path the renderer sends; legitimate
 * paths always come from listSkills/listAgents. Listing code registers the
 * canonical path here, and read handlers only accept that exact canonical path.
 * This rejects arbitrary `.code-shell/.../*.md` strings, `..` traversal that
 * resolves elsewhere, and stale paths that were never listed.
 */
const listedMarkdownPaths = new Set<string>();

function canonicalCodeShellMarkdownPath(filePath: string): string {
  const resolved = realpathSync(path.resolve(filePath));
  const segments = resolved.split(path.sep);
  // `.agents/skills` is the canonical install location for `npx skills add`;
  // .code-shell/skills/<name> is symlinked to it, so realpathSync resolves the
  // physical path into `.agents`. Accept either root marker. The per-path
  // allowlist below (assert…) is the real gate against arbitrary reads; this
  // segment check only rejects paths that resolve nowhere near a skills dir.
  const hasAgentsSkillsRoot = segments.some(
    (segment, index) => segment === ".agents" && segments[index + 1] === "skills",
  );
  if (!segments.includes(".code-shell") && !hasAgentsSkillsRoot) {
    throw new Error(`refusing to read path outside .code-shell: ${filePath}`);
  }
  if (!resolved.toLowerCase().endsWith(".md")) {
    throw new Error(`refusing to read non-markdown file: ${filePath}`);
  }
  return resolved;
}

export function rememberCodeShellMarkdownPath(filePath: string): void {
  listedMarkdownPaths.add(canonicalCodeShellMarkdownPath(filePath));
}

export function assertCodeShellMarkdownPath(filePath: string): void {
  const resolved = canonicalCodeShellMarkdownPath(filePath);
  if (!listedMarkdownPaths.has(resolved)) {
    throw new Error(`refusing to read unlisted markdown path: ${filePath}`);
  }
}

export function _resetCodeShellMarkdownPathAllowlistForTests(): void {
  listedMarkdownPaths.clear();
}
