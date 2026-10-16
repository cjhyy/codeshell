import {
  LinkOperationError,
  type LinkValueSchema,
  type LinkOperationAuthorization,
  type LinkOperationContract,
} from "./operation-types.js";
import { getLinkConnectionRecipe } from "./recipes.js";

function matches(schema: LinkValueSchema, value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (schema.enum && !schema.enum.includes(value as string)) return false;
  if (schema.anyOf && !schema.anyOf.some((item) => matches(item, value, depth + 1))) return false;
  if (schema.oneOf && schema.oneOf.filter((item) => matches(item, value, depth + 1)).length !== 1)
    return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "string")
    return (
      typeof value === "string" &&
      value.length >= (schema.minLength ?? 0) &&
      value.length <= (schema.maxLength ?? Infinity) &&
      (!schema.pattern || new RegExp(schema.pattern).test(value))
    );
  if (schema.type === "number" || schema.type === "integer")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (schema.type !== "integer" || Number.isSafeInteger(value)) &&
      value >= (schema.minimum ?? -Infinity) &&
      value <= (schema.maximum ?? Infinity)
    );
  if (schema.type === "array")
    return (
      Array.isArray(value) &&
      value.length >= (schema.minItems ?? 0) &&
      value.length <= (schema.maxItems ?? Infinity) &&
      (!schema.items || value.every((item) => matches(schema.items!, item, depth + 1)))
    );
  if (schema.type === "object" || schema.required || schema.properties) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (schema.required?.some((key) => !Object.hasOwn(record, key))) return false;
    return Object.entries(record).every(([key, item]) => {
      if (["__proto__", "prototype", "constructor"].includes(key)) return false;
      const property = schema.properties?.[key];
      return property ? matches(property, item, depth + 1) : schema.additionalProperties !== false;
    });
  }
  return true;
}

export function validateLinkOperationValue(schema: LinkValueSchema, value: unknown): boolean {
  return matches(schema, value);
}

export function validateLinkOperationInput(
  contract: LinkOperationContract,
  input: unknown,
): asserts input is Record<string, unknown> {
  let size = Infinity;
  try {
    size = new TextEncoder().encode(JSON.stringify(input)).length;
  } catch {
    /* Reject cyclic/non-JSON inputs. */
  }
  if (size > contract.limits.inputBytes || !matches(contract.inputSchema, input))
    throw new LinkOperationError(
      "invalid_input",
      `Invalid parameters for ${contract.operationId}.`,
    );
}

export function assertLinkOperationResult(contract: LinkOperationContract, result: unknown): void {
  let size = Infinity;
  try {
    size = new TextEncoder().encode(JSON.stringify(result)).length;
  } catch {
    /* Fail closed. */
  }
  if (size > contract.limits.responseBytes || !matches(contract.outputSchema, result))
    throw new LinkOperationError("invalid_result", `Invalid result for ${contract.operationId}.`);
}

/** Content traits never decide whether an operation needs authorization. */
export function assertLinkOperationAuthorized(
  contract: LinkOperationContract,
  params: Record<string, unknown>,
  authorization: LinkOperationAuthorization,
): void {
  const recipe = getLinkConnectionRecipe(authorization.recipeId);
  if (
    !recipe ||
    authorization.providerId !== contract.providerId ||
    !authorization.connectionId ||
    !authorization.accountId ||
    !authorization.authorityRevision ||
    !contract.executors.includes(recipe.executor) ||
    !authorization.capabilityIds.includes(contract.operationId)
  )
    throw new LinkOperationError(
      "permission_denied",
      "The selected connection does not authorize this operation.",
    );
  if (contract.effect === "write" && recipe.executor === "cli")
    throw new LinkOperationError(
      "permission_denied",
      "CLI connections do not support verified writes.",
    );
  if (authorization.resources.kind === "upstream-scoped") {
    if (recipe.route === "brokered")
      throw new LinkOperationError(
        "permission_denied",
        "Broker operations require an explicit resource grant.",
      );
    return;
  }
  const group = authorization.resources.groups.find(
    (item) => item.id === contract.resourcePolicy.group,
  );
  if (!group)
    throw new LinkOperationError(
      "resource_not_granted",
      "The selected resource group is not authorized.",
    );
  if (contract.resourcePolicy.source !== "input") return; // The executor must filter listing results to this group.
  const selector = contract.resourcePolicy.selector;
  if (!selector)
    throw new LinkOperationError(
      "resource_not_granted",
      "The operation has no reviewed resource selector.",
    );
  let selected: string;
  if (selector.kind === "joined") {
    const parts = selector.fields.map((field) => params[field]);
    if (parts.some((part) => typeof part !== "string" || !part))
      throw new LinkOperationError("invalid_input", "An explicit resource target is required.");
    selected = parts.join(selector.separator ?? "/");
  } else {
    const value = selector.fields.map((field) => params[field]).find((item) => item !== undefined);
    if (typeof value !== "string" || !value)
      throw new LinkOperationError("invalid_input", "An explicit resource target is required.");
    selected = value;
    if (selector.kind === "slack-permalink" || /^https?:\/\//i.test(value)) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new LinkOperationError("invalid_input", "Invalid resource URL.");
      }
      const allowedHost =
        selector.kind === "slack-permalink"
          ? /^[a-z0-9-]+\.slack\.com$/.test(url.hostname)
          : selector.urlHosts?.includes(url.hostname);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedHost)
        throw new LinkOperationError("invalid_input", "Invalid resource URL.");
      selected = url.pathname.split("/").filter(Boolean)[selector.urlPathIndex ?? 1] ?? "";
    }
  }
  const normalize = (value: string) => {
    const normalized = selector.stripHyphens ? value.replaceAll("-", "") : value;
    return selector.lowercase ? normalized.toLowerCase() : normalized;
  };
  if (!group.items.some((item) => normalize(item.id) === normalize(selected)))
    throw new LinkOperationError(
      "resource_not_granted",
      "The resource is outside this connection's grant.",
    );
}
