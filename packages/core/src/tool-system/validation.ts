/**
 * Lightweight tool input validation against a JSON Schema.
 *
 * NOT a full JSON-Schema validator: it only checks `required` presence and
 * top-level primitive types (string/number/boolean). Arrays, objects, enums,
 * nested shapes, and formats are intentionally NOT validated — this is a
 * cheap pre-flight guard, not a substitute for the provider's own schema
 * enforcement. (Was previously labelled "Zod-based" and imported `z`, but
 * never used zod — corrected to avoid misleading readers.)
 */

/**
 * Validate tool args against the tool's inputSchema.
 * Returns null if valid, error string if invalid.
 */
export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  try {
    const properties = schema.properties as Record<string, any> | undefined;
    const required = (schema.required as string[]) ?? [];

    // Required-field presence does not depend on `properties` existing — a
    // schema may declare `required` with no `properties` block (e.g. a
    // malformed external MCP tool schema). Check it before the properties
    // guard so missing params are still caught.
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        return `Missing required parameter: ${field}`;
      }
    }

    if (!properties) return null; // No property shapes to type-check.

    // Type check each provided field
    for (const [key, value] of Object.entries(args)) {
      const propSchema = properties[key];
      if (!propSchema) continue; // Extra fields are OK

      const expectedType = propSchema.type as string;
      const actualType = typeof value;

      if (expectedType === "string" && actualType !== "string") {
        return `Parameter '${key}' must be a string, got ${actualType}`;
      }
      if (expectedType === "number" && actualType !== "number") {
        return `Parameter '${key}' must be a number, got ${actualType}`;
      }
      if (expectedType === "boolean" && actualType !== "boolean") {
        return `Parameter '${key}' must be a boolean, got ${actualType}`;
      }
    }

    return null;
  } catch {
    return null; // Don't block on validation errors
  }
}
