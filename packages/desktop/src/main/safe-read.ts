import * as path from "node:path";

/**
 * Guard for renderer-supplied file paths handed to readSkillBody/readAgentBody.
 *
 * Those handlers fs.readFile whatever path the renderer sends; legitimate
 * paths always come from listSkills/listAgents and live as `.md` files under a
 * `.code-shell` directory (user ~/.code-shell or a project <cwd>/.code-shell).
 * This rejects anything else — in particular `..` traversal that would resolve
 * outside a `.code-shell` tree, or non-markdown files — so a crafted path
 * can't exfiltrate arbitrary files. See review-2026-05-30 (security).
 */
export function assertCodeShellMarkdownPath(filePath: string): void {
  const resolved = path.resolve(filePath);
  const segments = resolved.split(path.sep);
  if (!segments.includes(".code-shell")) {
    throw new Error(`refusing to read path outside .code-shell: ${filePath}`);
  }
  if (!resolved.toLowerCase().endsWith(".md")) {
    throw new Error(`refusing to read non-markdown file: ${filePath}`);
  }
}
