/**
 * Detection — what does the cwd already contain?
 *
 * Drives the four-way intent decision in pickIntent. Synchronous and bounded
 * (≤ a handful of stat calls + one capped directory walk) so /init can pick a
 * mode without spawning an LLM turn just for classification.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Detection {
  // existing — AI config artifacts
  hasCodeshell: boolean;
  hasClaude: boolean;
  hasAgents: boolean;
  hasCursorRules: boolean;
  hasCursorRulesDir: boolean;
  hasWindsurfRules: boolean;
  hasClinerules: boolean;
  hasCopilotInstructions: boolean;
  hasCodeshellRulesDir: boolean;

  // new — used to distinguish create vs empty
  hasManifest: boolean;
  hasSourceFiles: boolean;
  hasReadme: boolean;
}

export type Intent = "improve" | "migrate" | "create" | "empty";

const MANIFEST_FILES = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "mix.exs",
  "deno.json",
  "deno.jsonc",
  "bun.lockb",
];

const README_NAMES = ["README.md", "README.rst", "README.txt", "README"];

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".rb",
  ".ex", ".exs", ".c", ".cpp", ".cc", ".h", ".hpp",
  ".swift", ".scala", ".clj", ".cljs", ".php",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target",
  ".venv", "venv", "__pycache__", ".next", ".turbo",
  "out", "coverage", ".cache",
]);

const SOURCE_SCAN_LIMIT = 50;

export function detect(cwd: string): Detection {
  const exists = (rel: string) => existsSync(join(cwd, rel));
  const isDir = (rel: string) => {
    try {
      return statSync(join(cwd, rel)).isDirectory();
    } catch {
      return false;
    }
  };
  const existsCI = (names: string[]) => {
    try {
      const entries = readdirSync(cwd);
      const lower = new Set(entries.map((e) => e.toLowerCase()));
      return names.some((n) => lower.has(n.toLowerCase()));
    } catch {
      return false;
    }
  };

  return {
    hasCodeshell: exists("CODESHELL.md"),
    hasClaude: exists("CLAUDE.md"),
    hasAgents: exists("AGENTS.md"),
    hasCursorRules: exists(".cursorrules"),
    hasCursorRulesDir: isDir(".cursor/rules"),
    hasWindsurfRules: exists(".windsurfrules"),
    hasClinerules: exists(".clinerules"),
    hasCopilotInstructions: exists(".github/copilot-instructions.md"),
    hasCodeshellRulesDir: isDir(".codeshell/rules"),

    hasManifest: MANIFEST_FILES.some((m) => exists(m)),
    hasSourceFiles: hasAnySourceFiles(cwd),
    hasReadme: existsCI(README_NAMES),
  };
}

export function pickIntent(d: Detection): Intent {
  if (d.hasCodeshell) return "improve";
  if (
    d.hasClaude ||
    d.hasAgents ||
    d.hasCursorRules ||
    d.hasCursorRulesDir ||
    d.hasWindsurfRules ||
    d.hasClinerules ||
    d.hasCopilotInstructions
  ) {
    return "migrate";
  }
  if (d.hasManifest || d.hasSourceFiles || d.hasReadme) return "create";
  return "empty";
}

export function summarize(d: Detection): string {
  const found: string[] = [];
  if (d.hasCodeshell) found.push("CODESHELL.md");
  if (d.hasClaude) found.push("CLAUDE.md");
  if (d.hasAgents) found.push("AGENTS.md");
  if (d.hasCursorRulesDir) found.push(".cursor/rules/");
  if (d.hasCursorRules) found.push(".cursorrules");
  if (d.hasWindsurfRules) found.push(".windsurfrules");
  if (d.hasClinerules) found.push(".clinerules");
  if (d.hasCopilotInstructions) found.push(".github/copilot-instructions.md");
  if (d.hasCodeshellRulesDir) found.push(".codeshell/rules/");

  const code: string[] = [];
  if (d.hasManifest) code.push("manifest");
  if (d.hasSourceFiles) code.push("source files");
  if (d.hasReadme) code.push("README");

  if (found.length === 0 && code.length === 0) return "Detected: empty repository";
  const parts: string[] = [];
  if (found.length) parts.push(found.join(", "));
  if (code.length) parts.push(code.join(" + "));
  return `Detected: ${parts.join("; ")}`;
}

/**
 * Look at cwd root and src/ (if present) for at least one source file.
 * Bounded by SOURCE_SCAN_LIMIT total entries inspected.
 */
function hasAnySourceFiles(cwd: string): boolean {
  let budget = SOURCE_SCAN_LIMIT;

  const scanLevel = (dir: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    for (const name of entries) {
      if (budget-- <= 0) return false;
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith(".")) continue;
      const ext = extOf(name);
      if (ext && SOURCE_EXTS.has(ext)) return true;
    }
    return false;
  };

  if (scanLevel(cwd)) return true;
  const srcDir = join(cwd, "src");
  try {
    if (statSync(srcDir).isDirectory() && scanLevel(srcDir)) return true;
  } catch {
    /* no src/ */
  }
  return false;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i);
}
