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
import type { ContextSection } from "../context/context-ledger.js";

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
    if (typeof output.text !== "string" || !output.text) continue;
    const key = ownSectionKey(output);
    if (key === undefined || keys.has(key)) {
      shared.push(output.text);
      continue;
    }
    keys.add(key);
    own.push({
      key,
      text: output.text,
      ...(output.compare === "snapshot-only" ? { compare: "snapshot-only" as const } : {}),
    });
  }
  return [{ key: "capability", text: shared.join("\n\n") }, ...own];
}
