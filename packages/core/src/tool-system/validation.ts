/**
 * Zod-based tool input validation.
 * Validates tool args against JSON Schema before execution.
 */
import { z } from "zod";

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

    if (!properties) return null;

    // Check required fields
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        return `Missing required parameter: ${field}`;
      }
    }

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
