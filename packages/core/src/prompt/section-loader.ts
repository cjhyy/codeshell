/**
 * Load prompt section markdown files.
 *
 * Sections are read from disk at module load. The package build copies these
 * files to dist/prompt/sections so plain Node ESM can import core without a
 * custom .md loader.
 */

import { readFileSync } from "node:fs";

function readSectionFile(name: string): string {
  return readFileSync(new URL(`./sections/${name}.md`, import.meta.url), "utf-8");
}

const BUILTIN_SECTIONS: Record<string, string> = {
  "harness-base": readSectionFile("harness-base"),
  base: readSectionFile("base"),
  orchestration: readSectionFile("orchestration"),
  browser: readSectionFile("browser"),
  tone: readSectionFile("tone"),
};

/**
 * Read a named prompt section. Returns the trimmed markdown content.
 * Contributed (module) sections win over built-ins; throws on unknown names.
 */
export function loadSection(name: string, sections?: Readonly<Record<string, string>>): string {
  const contributed = sections?.[name];
  if (contributed !== undefined) return contributed.trim();

  const builtin = BUILTIN_SECTIONS[name];
  if (builtin !== undefined) return builtin.trim();

  const available = Object.keys(BUILTIN_SECTIONS).join(", ");
  throw new Error(`Unknown prompt section "${name}". Available sections: ${available}`);
}

/**
 * Load multiple sections and join them with double newlines.
 */
export function loadSections(
  names: readonly string[],
  sections?: Readonly<Record<string, string>>,
): string {
  return names.map((name) => loadSection(name, sections)).join("\n\n");
}

/**
 * List the built-in section names.
 */
export function availableSections(): string[] {
  return [...Object.keys(BUILTIN_SECTIONS)];
}
