/**
 * ToolRegistry appends execution-only fields after schema validation. Pet tool
 * handlers still validate their public arguments defensively, so those known
 * internal fields must not be mistaken for model-supplied properties.
 */
const INTERNAL_TOOL_ARGUMENTS = new Set(["__signal"]);

export function hasOnlyDeclaredToolArguments(
  args: Record<string, unknown>,
  declared: readonly string[],
): boolean {
  const allowed = new Set(declared);
  return Object.keys(args).every((key) => allowed.has(key) || INTERNAL_TOOL_ARGUMENTS.has(key));
}
