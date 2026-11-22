import { readLatestAssistantText, LATEST_RESULT_MAX_CHARS } from "@cjhyy/code-shell-pet/disclosure";

/** Default closure-input reader: the tail assistant text of the session. */
export async function readPetSummaryInput(sessionDir: string): Promise<string | null> {
  const latest = await readLatestAssistantText(sessionDir, { maxChars: LATEST_RESULT_MAX_CHARS });
  const text = latest?.text?.trim();
  return text ? text : null;
}
