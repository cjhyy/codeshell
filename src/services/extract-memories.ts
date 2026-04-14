/**
 * Extract Memories service — extract durable memories from session transcripts.
 *
 * Runs at the end of a query loop to identify important information
 * worth persisting across sessions.
 */

export interface ExtractedMemory {
  type: "user" | "feedback" | "project" | "reference";
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
Identify NEW information that should be saved as persistent memories. Categories:
- **user**: Information about the user's role, preferences, or expertise
- **feedback**: Guidance about how to approach work (corrections or confirmations)
- **project**: Non-obvious facts about ongoing work, goals, or decisions
- **reference**: Pointers to external resources or systems

Rules:
- Only extract information that would be useful in FUTURE conversations
- Do not duplicate existing memories
- Do not extract code patterns, file structures, or git history (derivable from code)
- Do not extract ephemeral task details
- Each memory should have a clear, specific description

Respond with a JSON array of objects with fields: type, name, description, content
If nothing worth remembering, respond with an empty array: []`;
}

/**
 * Parse extracted memories from LLM response.
 */
export function parseExtractionResponse(response: string): ExtractedMemory[] {
  try {
    // Find JSON array in response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (m: unknown): m is ExtractedMemory =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as any).type === "string" &&
        typeof (m as any).name === "string" &&
        typeof (m as any).content === "string" &&
        ["user", "feedback", "project", "reference"].includes((m as any).type),
    );
  } catch {
    return [];
  }
}
