/**
 * Capability-owned dynamic context, split into context-ledger sections.
 *
 * Plain text from every provider shares the whole-text "capability" section.
 * A provider that returns a {@link CapabilityDynamicContextSection} gets a
 * section of its own, so it can be compared on its own terms — a git status
 * is "snapshot-only" (see context/context-ledger.ts) while other capability
 * text keeps whole-text updates.
 */
import type { CapabilityDynamicContextSection } from "../capabilities/index.js";
import { contextListSection, type ContextSection } from "../context/context-ledger.js";

export type CapabilityContextOutput = string | CapabilityDynamicContextSection | undefined;

/** A section key is an identifier, never free text: it is written into a tag attribute. */
const SECTION_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_KEY_LENGTH = 40;

function ownSectionKey(output: CapabilityDynamicContextSection): string | undefined {
  return typeof output.key === "string" &&
    output.key.length <= MAX_KEY_LENGTH &&
    SECTION_KEY.test(output.key)
    ? `capability-${output.key}`
    : undefined;
}

const MAX_LIST_ITEMS = 512;

/** A provider's list section, or undefined when it is not a well-formed list. */
function listSection(output: CapabilityDynamicContextSection): ContextSection | undefined {
  const items = output.items;
  if (!Array.isArray(items) || items.length > MAX_LIST_ITEMS) return undefined;
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.text !== "string")
      return undefined;
    if (ids.has(item.id)) return undefined;
    ids.add(item.id);
  }
  const header = typeof output.header === "string" ? output.header : "";
  const footer = typeof output.footer === "string" ? output.footer : "";
  const section = contextListSection("", {
    header,
    footer,
    // A row is one line; the ledger quotes removals by label.
    items: items.map((item) => ({
      id: item.id,
      text: item.text.replace(/\r?\n/g, " "),
      ...(typeof item.label === "string" && item.label ? { label: item.label } : {}),
    })),
  });
  if (output.compare !== "ids") return section;
  const known = Array.isArray(output.knownIds)
    ? output.knownIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [...ids];
  return { ...section, compare: "ids", knownIds: [...new Set([...known, ...ids])] };
}

/**
 * The "capability" section followed by each provider section, in provider
 * order. A section with an unusable or repeated key is not lost: its text
 * joins the shared capability text.
 */
export function capabilityContextSections(
  outputs: readonly CapabilityContextOutput[],
): ContextSection[] {
  const shared: string[] = [];
  const own: ContextSection[] = [];
  const keys = new Set<string>();
  for (const output of outputs) {
    if (!output) continue;
    if (typeof output === "string") {
      shared.push(output);
      continue;
    }
    if (output.unchanged === true) {
      const key = ownSectionKey(output);
      // Without its own key it names nothing to keep.
      if (key === undefined || keys.has(key)) continue;
      keys.add(key);
      own.push({ key, text: "", unchanged: true });
      continue;
    }
    const list = listSection(output);
    const text = list ? list.text : output.text;
    if (typeof text !== "string" || (!text && !list)) continue;
    const key = ownSectionKey(output);
    if (key === undefined || keys.has(key)) {
      if (text) shared.push(text);
      continue;
    }
    keys.add(key);
    if (list) {
      own.push({ ...list, key });
      continue;
    }
    own.push({
      key,
      text,
      ...(output.compare === "snapshot-only" ? { compare: "snapshot-only" as const } : {}),
    });
  }
  return [{ key: "capability", text: shared.join("\n\n") }, ...own];
}
