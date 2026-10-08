import type { DigitalHumanProfileEntry } from "./types";

/** Browser-side validation mirrors the authoritative Profile schema in main. */
export function parseSourceAccessDraft(text: string): DigitalHumanProfileEntry["sourceAccess"] {
  if (!text.trim()) return undefined;
  if (text.length > 131_072) throw new Error("Source access policy is too large");
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > 1_000)
    throw new Error("Expected a source access array");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.sourceId !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.sourceId) ||
      ids.has(entry.sourceId) ||
      !Array.isArray(entry.scopes) ||
      entry.scopes.length > 1_000 ||
      entry.scopes.some(
        (scope: unknown) =>
          typeof scope !== "string" || !scope || scope.length > 512 || scope.includes("\0"),
      ) ||
      new Set(entry.scopes).size !== entry.scopes.length ||
      ![undefined, "ask", "deny"].includes(entry.readPolicy)
    ) {
      throw new Error("Invalid source access entry");
    }
    ids.add(entry.sourceId);
    return {
      sourceId: entry.sourceId,
      scopes: entry.scopes,
      readPolicy: entry.readPolicy ?? "ask",
    };
  });
}
