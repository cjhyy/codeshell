/**
 * Test helper: a composer's dynamic context as the first snapshot message the
 * context ledger sends (engine/run-context-ledger.ts), built from the same
 * production functions.
 */
import { renderContextSnapshot } from "../context/context-ledger.js";
import type { PromptComposer } from "./composer.js";
import type { Message } from "../types.js";

export async function dynamicContextSnapshot(
  composer: Pick<PromptComposer, "buildDynamicContextSections">,
): Promise<Message | null> {
  const content = renderContextSnapshot(await composer.buildDynamicContextSections());
  return content === null ? null : { role: "user", content };
}
