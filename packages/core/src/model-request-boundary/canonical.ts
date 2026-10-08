import { createHash } from "node:crypto";

/** JSON semantics, then stable object ordering; array order remains evidence. */
export function canonicalJson(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, ordered((input as Record<string, unknown>)[key])]),
      );
    return input;
  };
  return JSON.stringify(ordered(normalized));
}

/** Public metadata digest, or a transient prehash passed only to Host custody. */
export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
