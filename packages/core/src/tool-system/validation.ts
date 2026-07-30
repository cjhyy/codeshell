/**
 * Compatibility validator used by existing built-ins and third-party MCP
 * schemas. It checks `required` presence and top-level primitive types only;
 * changing that permissive contract would be a broad compatibility break.
 *
 * Reviewed Panel App schemas use the fail-closed recursive validator exported
 * later in this module (`validateToolArgsStrict`).
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

type JsonSchema = Record<string, unknown> | boolean;

function schemaObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return schemaObject(value);
  if (type === "integer")
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function schemaTypeLabel(type: string): string {
  if (type === "integer") return "an integer";
  if (type === "array") return "an array";
  if (type === "object") return "an object";
  if (type === "number") return "a finite number";
  if (type === "boolean") return "a boolean";
  if (type === "null") return "null";
  return `a ${type}`;
}

function schemaPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent ? `${parent}.${key}` : key;
}

function schemaValueKey(value: unknown, depth = 0): string | null {
  if (depth > 64) return null;
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return `number:${value === 0 ? 0 : value}`;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => schemaValueKey(item, depth + 1));
    if (items.some((item) => item === null)) return null;
    return `array:[${items.join(",")}]`;
  }
  if (!schemaObject(value)) return null;
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const child = schemaValueKey(value[key], depth + 1);
      return child === null ? null : `${JSON.stringify(key)}:${child}`;
    });
  if (entries.some((entry) => entry === null)) return null;
  return `object:{${entries.join(",")}}`;
}

function schemaValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  const leftKey = schemaValueKey(left);
  const rightKey = schemaValueKey(right);
  return leftKey !== null && rightKey !== null && leftKey === rightKey;
}

function branchRelevance(
  value: unknown,
  branch: JsonSchema,
  root: Record<string, unknown>,
): number {
  if (!schemaObject(value) || !schemaObject(branch)) return 0;
  let candidate = branch;
  if (typeof candidate.$ref === "string") {
    const referenced = resolveLocalSchemaReference(root, candidate.$ref);
    if (referenced && schemaObject(referenced)) candidate = referenced;
  }
  const properties = schemaObject(candidate.properties) ? candidate.properties : {};
  let score = 0;
  for (const [key, property] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key) || !schemaObject(property)) continue;
    if (Object.hasOwn(property, "const")) {
      score += schemaValueEqual(value[key], property.const) ? 1_000 : -1_000;
    } else if (Array.isArray(property.enum)) {
      score += property.enum.some((entry) => schemaValueEqual(value[key], entry)) ? 500 : -500;
    }
  }
  if (Array.isArray(candidate.required)) {
    for (const field of candidate.required) {
      if (typeof field === "string") score += Object.hasOwn(value, field) ? 1 : -1;
    }
  }
  return score;
}

function relevantBranchError(
  value: unknown,
  branches: JsonSchema[],
  errors: Array<string | null>,
  root: Record<string, unknown>,
): string | null {
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [index, error] of errors.entries()) {
    if (error === null) continue;
    const score = branchRelevance(value, branches[index], root);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex >= 0 ? errors[bestIndex] : null;
}

function strictSchemaFailure(error: string | null): error is string {
  return Boolean(
    error?.startsWith("Invalid JSON Schema") ||
    error?.startsWith("Unsupported or unresolved JSON Schema") ||
    error?.includes("exceeds the schema evaluation limit") ||
    error?.includes("exceeds the schema depth limit"),
  );
}

function resolveLocalSchemaReference(
  root: Record<string, unknown>,
  reference: string,
): JsonSchema | null {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return null;
  let current: unknown = root;
  for (const rawSegment of reference.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!schemaObject(current) || !Object.hasOwn(current, segment)) return null;
    current = current[segment];
  }
  return typeof current === "boolean" || schemaObject(current) ? current : null;
}

const STRICT_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "items",
  "maxProperties",
  "minProperties",
  "required",
  "properties",
  "additionalProperties",
]);

const MAX_STRICT_SCHEMA_PATTERN_LENGTH = 512;
const MAX_STRICT_PATTERN_INPUT_LENGTH = 10_000;
const MAX_STRICT_VALUE_NODES = 20_000;
const MAX_STRICT_SCHEMA_EVALUATIONS = 100_000;

function validateStrictJsonValue(
  value: unknown,
  path: string,
  depth: number,
  ancestors: WeakSet<object>,
  budget: { remaining: number },
): string | null {
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    return `Parameter '${path || "arguments"}' exceeds the JSON value-size limit`;
  }
  if (depth > 64) {
    return `Parameter '${path || "arguments"}' exceeds the JSON value depth limit`;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? null
      : `Parameter '${path || "arguments"}' must contain only finite JSON numbers`;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return `Parameter '${path || "arguments"}' contains a circular JSON value`;
    }
    ancestors.add(value);
    for (const [index, child] of value.entries()) {
      const error = validateStrictJsonValue(
        child,
        schemaPath(path, index),
        depth + 1,
        ancestors,
        budget,
      );
      if (error) return error;
    }
    ancestors.delete(value);
    return null;
  }
  if (schemaObject(value)) {
    if (ancestors.has(value)) {
      return `Parameter '${path || "arguments"}' contains a circular JSON value`;
    }
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      const error = validateStrictJsonValue(
        child,
        schemaPath(path, key),
        depth + 1,
        ancestors,
        budget,
      );
      if (error) return error;
    }
    ancestors.delete(value);
    return null;
  }
  return `Parameter '${path || "arguments"}' must contain only JSON values`;
}

function supportedStrictSchemaPattern(pattern: string): boolean {
  if (pattern.length > MAX_STRICT_SCHEMA_PATTERN_LENGTH) return false;
  let escaped = false;
  let inCharacterClass = false;
  let variableQuantifiers = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      if (!inCharacterClass && /[1-9k]/u.test(character)) return false;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[" && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (!inCharacterClass && ["(", ")", "|", "."].includes(character)) return false;
    if (!inCharacterClass && ["*", "+", "?"].includes(character)) {
      variableQuantifiers += 1;
      continue;
    }
    if (!inCharacterClass && character === "{") {
      const closingBrace = pattern.indexOf("}", index + 1);
      if (closingBrace < 0) return false;
      const body = pattern.slice(index + 1, closingBrace);
      const match = /^(\d+)(?:,(\d+))?$/u.exec(body);
      if (!match) return false;
      const minimum = Number(match[1]);
      const maximum = match[2] === undefined ? minimum : Number(match[2]);
      if (
        !Number.isSafeInteger(minimum) ||
        !Number.isSafeInteger(maximum) ||
        minimum > maximum ||
        maximum > MAX_STRICT_PATTERN_INPUT_LENGTH
      ) {
        return false;
      }
      if (minimum !== maximum) variableQuantifiers += 1;
      index = closingBrace;
      continue;
    }
    if (!inCharacterClass && character === "}") return false;
  }
  if (escaped || inCharacterClass || variableQuantifiers > 1) return false;
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

function validateStrictSchemaDefinition(
  schema: JsonSchema,
  root: Record<string, unknown>,
  path: string,
  depth: number,
  seen: WeakSet<object>,
): string | null {
  if (depth > 64) return `Invalid JSON Schema: '${path}' exceeds the schema depth limit`;
  if (typeof schema === "boolean") return null;
  if (!schemaObject(schema)) return `Invalid JSON Schema at '${path}'`;
  if (seen.has(schema)) return null;
  seen.add(schema);
  const label = path || "arguments";
  for (const keyword of Object.keys(schema)) {
    if (!STRICT_SCHEMA_KEYWORDS.has(keyword)) {
      return `Unsupported JSON Schema keyword '${keyword}' at '${label}'`;
    }
  }
  for (const keyword of ["$schema", "$id", "$comment", "title", "description"] as const) {
    if (schema[keyword] !== undefined && typeof schema[keyword] !== "string") {
      return `Invalid JSON Schema ${keyword} at '${label}'`;
    }
  }
  for (const keyword of ["deprecated", "readOnly", "writeOnly"] as const) {
    if (schema[keyword] !== undefined && typeof schema[keyword] !== "boolean") {
      return `Invalid JSON Schema ${keyword} at '${label}'`;
    }
  }
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) {
    return `Invalid JSON Schema examples at '${label}'`;
  }
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string") {
      return `Invalid JSON Schema reference at '${label}'`;
    }
    const referenced = resolveLocalSchemaReference(root, schema.$ref);
    if (!referenced) return `Unsupported or unresolved JSON Schema reference: ${schema.$ref}`;
    const referenceError = validateStrictSchemaDefinition(
      referenced,
      root,
      `${label}.$ref`,
      depth + 1,
      seen,
    );
    if (referenceError) return referenceError;
  }
  const declaredTypes =
    typeof schema.type === "string"
      ? [schema.type]
      : Array.isArray(schema.type) && schema.type.every((type) => typeof type === "string")
        ? schema.type
        : schema.type === undefined
          ? []
          : null;
  if (
    declaredTypes === null ||
    (schema.type !== undefined && declaredTypes.length === 0) ||
    declaredTypes.length !== new Set(declaredTypes).size ||
    declaredTypes.some(
      (type) =>
        !["null", "array", "object", "integer", "number", "string", "boolean"].includes(type),
    )
  ) {
    return `Invalid JSON Schema type at '${label}'`;
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      return `Invalid JSON Schema enum at '${label}'`;
    }
    const enumKeys = schema.enum.map((candidate) => schemaValueKey(candidate));
    if (
      enumKeys.some((key) => key === null) ||
      new Set(enumKeys as string[]).size !== enumKeys.length
    ) {
      return `Invalid JSON Schema enum at '${label}'`;
    }
  }
  for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (
      schema[keyword] !== undefined &&
      (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword]))
    ) {
      return `Invalid JSON Schema ${keyword} at '${label}'`;
    }
  }
  if (
    schema.multipleOf !== undefined &&
    (typeof schema.multipleOf !== "number" ||
      !Number.isFinite(schema.multipleOf) ||
      schema.multipleOf <= 0)
  ) {
    return `Invalid JSON Schema multipleOf at '${label}'`;
  }
  for (const keyword of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ] as const) {
    const value = schema[keyword];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    ) {
      return `Invalid JSON Schema ${keyword} at '${label}'`;
    }
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    return `Invalid JSON Schema uniqueItems at '${label}'`;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || !supportedStrictSchemaPattern(schema.pattern)) {
      return `Invalid JSON Schema pattern at '${label}'`;
    }
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some((field) => typeof field !== "string") ||
      schema.required.length !== new Set(schema.required).size)
  ) {
    return `Invalid JSON Schema required-list at '${label}'`;
  }
  if (schema.$defs !== undefined && !schemaObject(schema.$defs)) {
    return `Invalid JSON Schema $defs at '${label}'`;
  }
  if (schema.properties !== undefined && !schemaObject(schema.properties)) {
    return `Invalid JSON Schema properties at '${label}'`;
  }
  const nestedSchemas: Array<[string, unknown]> = [];
  for (const keyword of ["$defs", "properties"] as const) {
    if (!schemaObject(schema[keyword])) continue;
    for (const [key, child] of Object.entries(schema[keyword])) {
      nestedSchemas.push([`${label}.${keyword}.${key}`, child]);
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (branches === undefined) continue;
    if (
      !Array.isArray(branches) ||
      branches.length === 0 ||
      branches.some((branch) => typeof branch !== "boolean" && !schemaObject(branch))
    ) {
      return `Invalid JSON Schema ${keyword} at '${label}'`;
    }
    branches.forEach((branch, index) =>
      nestedSchemas.push([`${label}.${keyword}[${index}]`, branch]),
    );
  }
  for (const keyword of ["not", "if", "then", "else", "items", "additionalProperties"] as const) {
    const child = schema[keyword];
    if (child === undefined) continue;
    if (typeof child !== "boolean" && !schemaObject(child)) {
      return `Invalid JSON Schema ${keyword} at '${label}'`;
    }
    nestedSchemas.push([`${label}.${keyword}`, child]);
  }
  for (const [childPath, child] of nestedSchemas) {
    const childError = validateStrictSchemaDefinition(
      child as JsonSchema,
      root,
      childPath,
      depth + 1,
      seen,
    );
    if (childError) return childError;
  }
  return null;
}

function validateStrictSchemaValue(
  value: unknown,
  schema: JsonSchema,
  root: Record<string, unknown>,
  path: string,
  depth: number,
  budget: { remaining: number },
): string | null {
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    return `Parameter '${path || "arguments"}' exceeds the schema evaluation limit`;
  }
  if (depth > 64) return `Parameter '${path || "arguments"}' exceeds the schema depth limit`;
  if (schema === true) return null;
  if (schema === false) return `Parameter '${path || "arguments"}' is not allowed`;
  if (!schemaObject(schema)) return `Invalid JSON Schema at '${path || "arguments"}'`;

  if (typeof schema.$ref === "string") {
    const referenced = resolveLocalSchemaReference(root, schema.$ref);
    if (!referenced) return `Unsupported or unresolved JSON Schema reference: ${schema.$ref}`;
    const referenceError = validateStrictSchemaValue(
      value,
      referenced,
      root,
      path,
      depth + 1,
      budget,
    );
    if (referenceError) return referenceError;
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (branches === undefined) continue;
    if (
      !Array.isArray(branches) ||
      branches.some((branch) => typeof branch !== "boolean" && !schemaObject(branch))
    ) {
      return `Invalid JSON Schema ${keyword} at '${path || "arguments"}'`;
    }
    const errors = (branches as JsonSchema[]).map((branch) =>
      validateStrictSchemaValue(value, branch, root, path, depth + 1, budget),
    );
    const schemaFailure = errors.find(strictSchemaFailure);
    if (schemaFailure) return schemaFailure;
    const matches = errors.filter((error) => error === null).length;
    if (keyword === "allOf" && matches !== branches.length) {
      return (
        errors.find((error): error is string => error !== null) ?? `Parameter '${path}' is invalid`
      );
    }
    if (keyword === "anyOf" && matches === 0) {
      return (
        relevantBranchError(value, branches as JsonSchema[], errors, root) ??
        `Parameter '${path}' is invalid`
      );
    }
    if (keyword === "oneOf" && matches !== 1) {
      return matches === 0
        ? (relevantBranchError(value, branches as JsonSchema[], errors, root) ??
            `Parameter '${path}' must match one allowed shape`)
        : `Parameter '${path || "arguments"}' matches more than one oneOf branch`;
    }
  }

  if (schema.not !== undefined) {
    if (typeof schema.not !== "boolean" && !schemaObject(schema.not)) {
      return `Invalid JSON Schema not-clause at '${path || "arguments"}'`;
    }
    const notError = validateStrictSchemaValue(
      value,
      schema.not as JsonSchema,
      root,
      path,
      depth + 1,
      budget,
    );
    if (strictSchemaFailure(notError)) return notError;
    if (notError === null) {
      return `Parameter '${path || "arguments"}' matches a forbidden shape`;
    }
  }

  if (schema.if !== undefined) {
    if (typeof schema.if !== "boolean" && !schemaObject(schema.if)) {
      return `Invalid JSON Schema if-clause at '${path || "arguments"}'`;
    }
    const conditionError = validateStrictSchemaValue(
      value,
      schema.if as JsonSchema,
      root,
      path,
      depth + 1,
      budget,
    );
    if (strictSchemaFailure(conditionError)) return conditionError;
    const conditionMatches = conditionError === null;
    const selected = conditionMatches ? schema.then : schema.else;
    if (selected !== undefined) {
      if (typeof selected !== "boolean" && !schemaObject(selected)) {
        return `Invalid JSON Schema conditional at '${path || "arguments"}'`;
      }
      const conditionalError = validateStrictSchemaValue(
        value,
        selected as JsonSchema,
        root,
        path,
        depth + 1,
        budget,
      );
      if (conditionalError) return conditionalError;
    }
  }

  const declaredTypes =
    typeof schema.type === "string"
      ? [schema.type]
      : Array.isArray(schema.type) && schema.type.every((type) => typeof type === "string")
        ? schema.type
        : schema.type === undefined
          ? []
          : null;
  if (
    declaredTypes === null ||
    declaredTypes.some(
      (type) =>
        !["null", "array", "object", "integer", "number", "string", "boolean"].includes(type),
    )
  ) {
    return `Invalid JSON Schema type at '${path || "arguments"}'`;
  }
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => schemaTypeMatches(value, type))) {
    const expected = declaredTypes.map(schemaTypeLabel).join(" or ");
    return `Parameter '${path || "arguments"}' must be ${expected}`;
  }

  if (Object.hasOwn(schema, "const") && !schemaValueEqual(value, schema.const)) {
    return `Parameter '${path || "arguments"}' must equal ${JSON.stringify(schema.const)}`;
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    return `Invalid JSON Schema enum at '${path || "arguments"}'`;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => schemaValueEqual(value, candidate))
  ) {
    return `Parameter '${path || "arguments"}' must be one of the declared enum values`;
  }

  if (typeof value === "string") {
    const characterLength = Array.from(value).length;
    if (typeof schema.minLength === "number" && characterLength < schema.minLength) {
      return `Parameter '${path}' must contain at least ${schema.minLength} characters`;
    }
    if (typeof schema.maxLength === "number" && characterLength > schema.maxLength) {
      return `Parameter '${path}' must contain at most ${schema.maxLength} characters`;
    }
    if (typeof schema.pattern === "string") {
      if (value.length > MAX_STRICT_PATTERN_INPUT_LENGTH) {
        return `Parameter '${path}' is too long for pattern validation`;
      }
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) {
          return `Parameter '${path}' does not match its required pattern`;
        }
      } catch {
        return `Invalid JSON Schema pattern at '${path}'`;
      }
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `Parameter '${path}' must be at least ${schema.minimum}`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `Parameter '${path}' must be at most ${schema.maximum}`;
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      return `Parameter '${path}' must be greater than ${schema.exclusiveMinimum}`;
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      return `Parameter '${path}' must be less than ${schema.exclusiveMaximum}`;
    }
    if (
      typeof schema.multipleOf === "number" &&
      schema.multipleOf > 0 &&
      Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9
    ) {
      return `Parameter '${path}' must be a multiple of ${schema.multipleOf}`;
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `Parameter '${path}' must contain at least ${schema.minItems} item(s)`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `Parameter '${path}' must contain at most ${schema.maxItems} item(s)`;
    }
    if (
      schema.uniqueItems === true &&
      (() => {
        const keys = value.map((item) => schemaValueKey(item));
        return keys.some((key) => key === null) || new Set(keys).size !== keys.length;
      })()
    ) {
      return `Parameter '${path}' must contain unique items`;
    }
    if (schema.items !== undefined) {
      if (typeof schema.items !== "boolean" && !schemaObject(schema.items)) {
        return `Invalid JSON Schema items at '${path}'`;
      }
      for (const [index, item] of value.entries()) {
        const itemError = validateStrictSchemaValue(
          item,
          schema.items as JsonSchema,
          root,
          schemaPath(path, index),
          depth + 1,
          budget,
        );
        if (itemError) return itemError;
      }
    }
  }

  if (schemaObject(value)) {
    if (schema.properties !== undefined && !schemaObject(schema.properties)) {
      return `Invalid JSON Schema properties at '${path || "arguments"}'`;
    }
    const properties = schemaObject(schema.properties) ? schema.properties : {};
    const required = schema.required;
    if (
      required !== undefined &&
      (!Array.isArray(required) || required.some((field) => typeof field !== "string"))
    ) {
      return `Invalid JSON Schema required-list at '${path || "arguments"}'`;
    }
    for (const field of (required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(value, field)) {
        return `Missing required parameter: ${schemaPath(path, field)}`;
      }
    }
    if (
      typeof schema.minProperties === "number" &&
      Object.keys(value).length < schema.minProperties
    ) {
      return `Parameter '${path || "arguments"}' has too few properties`;
    }
    if (
      typeof schema.maxProperties === "number" &&
      Object.keys(value).length > schema.maxProperties
    ) {
      return `Parameter '${path || "arguments"}' has too many properties`;
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const propertySchema = properties[key];
        if (typeof propertySchema !== "boolean" && !schemaObject(propertySchema)) {
          return `Invalid JSON Schema property '${schemaPath(path, key)}'`;
        }
        const propertyError = validateStrictSchemaValue(
          child,
          propertySchema as JsonSchema,
          root,
          schemaPath(path, key),
          depth + 1,
          budget,
        );
        if (propertyError) return propertyError;
        continue;
      }
      if (schema.additionalProperties === false) {
        return `Unexpected parameter: ${schemaPath(path, key)}`;
      }
      if (
        typeof schema.additionalProperties === "boolean" ||
        schema.additionalProperties === undefined
      ) {
        continue;
      }
      if (!schemaObject(schema.additionalProperties)) {
        return `Invalid JSON Schema additionalProperties at '${path || "arguments"}'`;
      }
      const additionalError = validateStrictSchemaValue(
        child,
        schema.additionalProperties,
        root,
        schemaPath(path, key),
        depth + 1,
        budget,
      );
      if (additionalError) return additionalError;
    }
  }

  return null;
}

/**
 * Fail-closed recursive validation for reviewed Panel App Agent tools.
 *
 * This deliberately lives beside the lightweight validator instead of
 * changing its permissive compatibility contract for existing built-ins and
 * third-party MCP schemas.
 */
export function validateToolInputSchemaStrict(schema: Record<string, unknown>): string | null {
  try {
    const jsonError = validateStrictJsonValue(schema, "schema", 0, new WeakSet(), {
      remaining: MAX_STRICT_VALUE_NODES,
    });
    if (jsonError) return `Invalid JSON Schema: ${jsonError}`;
    return validateStrictSchemaDefinition(schema, schema, "", 0, new WeakSet());
  } catch {
    return "Invalid JSON Schema";
  }
}

export function validateToolArgsStrict(
  toolName: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  try {
    const schemaError = validateToolInputSchemaStrict(schema);
    if (schemaError) return schemaError;
    const jsonError = validateStrictJsonValue(args, "", 0, new WeakSet(), {
      remaining: MAX_STRICT_VALUE_NODES,
    });
    if (jsonError) return jsonError;
    return validateStrictSchemaValue(args, schema, schema, "", 0, {
      remaining: MAX_STRICT_SCHEMA_EVALUATIONS,
    });
  } catch {
    return `Invalid JSON Schema for tool '${toolName}'`;
  }
}
