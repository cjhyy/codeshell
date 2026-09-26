import { createHash } from "node:crypto";

/**
 * Serialize JSON data with object keys in UTF-16 code-unit order. Reject values
 * JSON would omit or coerce: otherwise distinct inputs could share a hash.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("canonical JSON requires finite, acyclic JSON data");
  }
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonical JSON requires plain objects");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("canonical JSON does not support symbol keys");
  }
  const property = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("canonical JSON requires enumerable data properties");
    }
    return descriptor.value;
  };
  ancestors.add(value);
  try {
    if (isArray) {
      if (keys.length !== value.length + 1) {
        throw new TypeError("canonical JSON does not support sparse or extended arrays");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        items.push(encode(property(String(index)), ancestors));
      }
      return `[${items.join(",")}]`;
    }
    return `{${(keys as string[])
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(property(key), ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
