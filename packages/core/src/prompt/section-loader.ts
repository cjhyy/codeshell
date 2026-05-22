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
  base: readSectionFile("base"),
  orchestration: readSectionFile("orchestration"),
  coding: readSectionFile("coding"),
  tone: readSectionFile("tone"),
};

/** Registry for custom sections added at runtime. */
const _customSections = new Map<string, string>();

/**
 * Register a custom prompt section at runtime.
 * This allows external presets to add their own sections.
 */
export function registerSection(name: string, content: string): void {
  _customSections.set(name, content);
}

/**
 * Read a named prompt section. Returns the trimmed markdown content.
 * Looks up built-in sections first, then custom-registered sections.
 * Throws if the section name is not found.
 */
export function loadSection(name: string): string {
  const builtin = BUILTIN_SECTIONS[name];
  if (builtin !== undefined) return builtin.trim();

  const custom = _customSections.get(name);
  if (custom !== undefined) return custom.trim();

  const available = [...Object.keys(BUILTIN_SECTIONS), ..._customSections.keys()].join(", ");
  throw new Error(`Unknown prompt section "${name}". Available sections: ${available}`);
}

/**
 * Load multiple sections and join them with double newlines.
 */
export function loadSections(names: readonly string[]): string {
  return names.map(loadSection).join("\n\n");
}

/**
 * List all available section names (built-in + custom).
 */
export function availableSections(): string[] {
  return [...Object.keys(BUILTIN_SECTIONS), ..._customSections.keys()];
}
