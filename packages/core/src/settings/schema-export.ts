/**
 * JSON Schema export for the settings file.
 *
 * Editors (VS Code et al.) can point a `$schema` at the emitted
 * `settings.schema.json` to get autocomplete + validation when hand-editing
 * `~/.code-shell/settings.json` or `<project>/.code-shell/settings.json`.
 *
 * This module is side-effect free: it only EXPOSES the generator and a writer.
 * `manager.load()` deliberately does NOT call these — emitting a file during
 * load would pollute test HOMEs and add disk I/O to every boot. A host that
 * wants the file on disk should call `writeSettingsSchemaFile()` explicitly
 * (wiring TBD — see the task return note).
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { SettingsSchema } from "./schema.js";

/**
 * Generate the JSON Schema for the settings object. The `name` option makes
 * the root a `$ref` into `definitions.CodeShellSettings`, which is the shape
 * editors expect when wiring up `$schema`.
 */
export function settingsJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(SettingsSchema, { name: "CodeShellSettings" }) as Record<string, unknown>;
}

/**
 * Write the schema to `<dir>/settings.schema.json` using the same atomic
 * tmp-file + rename dance as SettingsManager.atomicWriteJson, so a concurrent
 * reader never sees a half-written file. Returns the absolute output path.
 */
export function writeSettingsSchemaFile(dir: string): string {
  const out = join(dir, "settings.schema.json");
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(settingsJsonSchema(), null, 2), "utf-8");
  renameSync(tmp, out);
  return out;
}
