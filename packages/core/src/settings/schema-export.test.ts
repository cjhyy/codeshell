import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsJsonSchema, writeSettingsSchemaFile } from "./schema-export.js";

describe("settingsJsonSchema", () => {
  it("returns a plain JSON Schema object", () => {
    const schema = settingsJsonSchema();
    expect(schema).toBeTypeOf("object");
    expect(schema).not.toBeNull();
  });

  it("exposes top-level properties for known settings keys", () => {
    const schema = settingsJsonSchema() as Record<string, unknown>;
    // zod-to-json-schema with { name } wraps the object under $ref/definitions.
    // Resolve to the actual object node before asserting on properties.
    const defs =
      (schema.definitions as Record<string, any> | undefined) ??
      (schema.$defs as Record<string, any> | undefined);
    const node = defs?.CodeShellSettings ?? schema;
    expect(node.type).toBe("object");
    expect(node.properties).toBeTypeOf("object");
    expect(node.properties).toHaveProperty("permissions");
    expect(node.properties).toHaveProperty("context");
  });
});

describe("writeSettingsSchemaFile", () => {
  it("writes settings.schema.json that round-trips to the same schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-schema-"));
    try {
      const out = writeSettingsSchemaFile(dir);
      expect(out).toBe(join(dir, "settings.schema.json"));
      expect(existsSync(out)).toBe(true);

      const parsed = JSON.parse(readFileSync(out, "utf-8"));
      expect(parsed).toEqual(settingsJsonSchema());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
