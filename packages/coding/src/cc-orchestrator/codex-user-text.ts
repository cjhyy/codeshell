/**
 * Codex can store host-provided context and the user's actual prompt as
 * separate `input_text` parts on the SAME user message. Joining every part
 * makes room titles start with AGENTS/plugin boilerplate; dropping the whole
 * message when its joined text starts with `<environment_context>` drops the
 * real prompt too. Keep user-authored parts and discard only known host
 * context parts.
 */
export function codexUserText(content: unknown): string {
  if (typeof content === "string") {
    return isInjectedCodexContext(content) ? "" : content;
  }
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter((text) => text.trim() && !isInjectedCodexContext(text))
    .join("\n");
}

function isInjectedCodexContext(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<recommended_plugins>") ||
    /^# AGENTS\.md instructions for\s/.test(trimmed)
  );
}
