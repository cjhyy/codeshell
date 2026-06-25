/**
 * Extract Memories service — extract durable memories from session transcripts.
 *
 * Runs at the end of a query loop to identify important information
 * worth persisting across sessions.
 */

export interface ExtractedMemory {
  type: "user" | "feedback" | "project" | "reference";
  /**
   * Storage location (用户拍板). "global" = a general lesson/preference that
   * still holds in a different project (→ ~/.code-shell/memory). "project" =
   * specific to the current repo (→ projects/<hash>/memory). Decided by the
   * extracting LLM. Missing/invalid → "project" (conservative: don't pollute
   * the global layer with one-off events).
   */
  scope: "global" | "project";
  name: string;
  description: string;
  content: string;
}

/**
 * Build the prompt for extracting memories from a conversation.
 */
export function buildExtractionPrompt(
  transcript: Array<{ role: string; content: string }>,
  existingMemories: Array<{ name: string; type: string; description: string }>,
): string {
  const conversationText = transcript
    .map((m) => `[${m.role}]: ${m.content.slice(0, 3000)}`)
    .join("\n\n");

  const existingList = existingMemories.length > 0
    ? existingMemories.map((m) => `  - [${m.type}] ${m.name}: ${m.description}`).join("\n")
    : "  (none)";

  return `Analyze the following conversation and extract any information worth remembering for future sessions.

## Existing Memories
${existingList}

## Conversation
${conversationText.slice(0, 30000)}

## Instructions
Identify NEW information that should be saved as persistent memories. Categories (type):
- **user**: Information about the user's role, preferences, or expertise
- **feedback**: Guidance about how to approach work (corrections or confirmations)
- **project**: Non-obvious facts about ongoing work, goals, or decisions
- **reference**: Pointers to external resources or systems

Also decide each memory's storage SCOPE. **Be VERY conservative about "global" — default to "project".**
- **global** (RARE — strong bar): ONLY a general working principle, durable user preference, or fact about WHO THE USER IS that would be useful in literally ANY project or task. Examples that qualify: "the user prefers Chinese replies", "always grep for consumers before declaring code dead", "git subprocess args need a -- separator".
  - A concrete task's setup or domain data is NOT global even though it isn't tied to a code repo. Counter-examples that are **project, NOT global**: a specific daily-news / morning-briefing workflow and its data sources; how to log into a specific website; a particular model's config parameters; one integration's auth choice. These are task/domain specifics → "project".
- **project** (DEFAULT): anything specific to this repo, this task, or this domain — including the counter-examples above.
- The test for global: "is this a general way-of-working or who-the-user-is that applies across EVERY project?" Only then global. When in any doubt → project.

Rules:
- Extract AT MOST 2 memories per session. Prefer 0 to a marginal one — most sessions are noise.
- AT MOST 1 of the extracted memories may be "global". The global layer is injected every session, so keep it tiny and high-value. If two candidates both seem global, keep the single most universal one global and make the other "project".
- Only extract information that would be useful in FUTURE conversations
- Do not duplicate existing memories (re-read the "Existing Memories" list above carefully)
- Do not extract code patterns, file structures, or git history (derivable from code)
- Do not extract ephemeral task details, progress snapshots, or in-flight work state — those belong in the conversation, not memory
- Do not extract one-off research products (news reports, AI industry summaries, slide deck content, daily progress dumps) — they're done and not "durable, reusable information"
- NEVER include secrets: API keys, tokens, passwords, private URLs with credentials. If the durable fact involves a credential, describe WHERE it lives (e.g. "key is in .env as FOO_KEY"), never the value itself
- Each memory should have a clear, specific description

Respond with a JSON array of objects with fields: type, scope, name, description, content
(scope must be "global" or "project")
If nothing worth remembering, respond with an empty array: []`;
}

/** Max memories to accept from a single extraction pass. Code-side cap that
 *  enforces the same limit the prompt asks for — the model occasionally
 *  ignores prompt rules, but this guarantees the cap. */
export const MAX_MEMORIES_PER_EXTRACTION = 2;

/**
 * Parse extracted memories from LLM response.
 *
 * `maxCount` caps how many memories are accepted from one pass (the code-side
 * guarantee of the prompt rule). Defaults to MAX_MEMORIES_PER_EXTRACTION; a
 * caller can pass `settings.memories.maxCount` to tune it. Non-positive or
 * absent → the default.
 */
export function parseExtractionResponse(
  response: string,
  maxCount?: number,
): ExtractedMemory[] {
  const cap =
    typeof maxCount === "number" && maxCount > 0
      ? Math.floor(maxCount)
      : MAX_MEMORIES_PER_EXTRACTION;
  try {
    // Find JSON array in response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const valid = parsed
      .filter(
        (m: unknown): m is Omit<ExtractedMemory, "scope"> & { scope?: unknown } =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as any).type === "string" &&
          typeof (m as any).name === "string" &&
          typeof (m as any).content === "string" &&
          ["user", "feedback", "project", "reference"].includes((m as any).type),
      )
      // Normalize scope: only "global" survives as global; everything else
      // (absent, "project", typos) → "project" — never promote to global by accident.
      .map((m): ExtractedMemory => ({
        type: m.type,
        scope: m.scope === "global" ? "global" : "project",
        name: m.name,
        description: m.description,
        content: m.content,
      }));

    // Hard cap (用户拍板 克制): at most 1 global per extraction. The prompt asks
    // for this, but the model may ignore it — enforce in code. Keep the first
    // global as-is; demote any further globals to project.
    let globalSeen = false;
    const capped = valid.map((m) => {
      if (m.scope !== "global") return m;
      if (globalSeen) return { ...m, scope: "project" as const };
      globalSeen = true;
      return m;
    });

    return capped.slice(0, cap);
  } catch {
    return [];
  }
}
