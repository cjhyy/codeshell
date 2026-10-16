import {
  LinkOperationError,
  type LinkValueSchema,
  type LinkOperationAuthorization,
  type LinkOperationContract,
} from "./operation-types.js";
import { getLinkConnectionRecipe } from "./recipes.js";

/** Copy JSON data without invoking getters, toJSON, inherited code or mutable caller objects. */
function snapshotJson(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  maxDepth: number,
  forbidKeys: boolean,
): unknown {
  if (depth > maxDepth) throw new Error("JSON nesting limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || ancestors.has(value))
    throw new Error("Invalid JSON data");
  const prototype = Object.getPrototypeOf(value);
  if (
    (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length
  )
    throw new Error("Invalid JSON object");
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (value.length > 100_000) throw new Error("JSON array limit");
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (descriptor && !Object.hasOwn(descriptor, "value")) throw new Error("JSON accessor");
        return descriptor?.value === undefined
          ? null
          : snapshotJson(descriptor.value, ancestors, depth + 1, maxDepth, forbidKeys);
      });
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (
        !Object.hasOwn(descriptor, "value") ||
        (forbidKeys && ["__proto__", "constructor", "prototype"].includes(key))
      )
        throw new Error("Invalid JSON property");
      if (descriptor.value !== undefined)
        result[key] = snapshotJson(descriptor.value, ancestors, depth + 1, maxDepth, forbidKeys);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

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
      const property =
        schema.properties && Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined;
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
  snapshotLinkOperationInput(contract, input);
}

export function snapshotLinkOperationInput(
  contract: LinkOperationContract,
  input: unknown,
): Record<string, unknown> {
  let detached: unknown;
  let size = Infinity;
  try {
    detached = snapshotJson(input, new Set(), 0, contract.limits.inputDepth, true);
    size = new TextEncoder().encode(JSON.stringify(detached)).length;
  } catch {
    /* Reject cyclic/non-JSON inputs. */
  }
  if (size > contract.limits.inputBytes || !matches(contract.inputSchema, detached))
    throw new LinkOperationError(
      "invalid_input",
      `Invalid parameters for ${contract.operationId}.`,
    );
  return detached as Record<string, unknown>;
}

export function assertLinkOperationResult(contract: LinkOperationContract, result: unknown): void {
  let detached: unknown;
  let size = Infinity;
  try {
    detached = snapshotJson(result, new Set(), 0, contract.limits.responseDepth, false);
    size = new TextEncoder().encode(JSON.stringify(detached)).length;
  } catch {
    /* Fail closed. */
  }
  if (size > contract.limits.responseBytes || !matches(contract.outputSchema, detached))
    throw new LinkOperationError("invalid_result", `Invalid result for ${contract.operationId}.`);
}

/** Applies equally to direct API, CLI, MCP and broker adapters. Missing identity fails closed. */
export function filterLinkOperationResult(
  contract: LinkOperationContract,
  result: unknown,
  authorization: LinkOperationAuthorization,
): unknown {
  if (
    authorization.resources.kind === "upstream-scoped" ||
    contract.resourcePolicy.source !== "grant-filtered"
  )
    return result;
  const filter = contract.resourcePolicy.resultFilter;
  const group = authorization.resources.groups.find(
    (item) => item.id === contract.resourcePolicy.group,
  );
  if (!filter || !group || !result || typeof result !== "object" || Array.isArray(result))
    throw new LinkOperationError(
      "invalid_result",
      "The operation cannot prove its result resource scope.",
    );
  const values = (result as Record<string, unknown>)[filter.collection];
  if (!Array.isArray(values))
    throw new LinkOperationError(
      "invalid_result",
      "The operation returned an invalid resource listing.",
    );
  const normalize = (value: string) => {
    const normalized = filter.stripHyphens ? value.replaceAll("-", "") : value;
    return filter.lowercase ? normalized.toLowerCase() : normalized;
  };
  const allowed = new Set(group.items.map((item) => normalize(item.id)));
  return {
    ...result,
    [filter.collection]: values.filter((item: unknown) => {
      let value = item;
      for (const key of filter.identityPath)
        value =
          value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
      return (
        (typeof value === "string" || typeof value === "number") &&
        allowed.has(normalize(String(value)))
      );
    }),
  };
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
