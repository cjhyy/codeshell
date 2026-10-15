/**
 * Codex can store host-provided context and the user's actual prompt as
 * separate `input_text` parts on the SAME user message. Joining every part
 * makes room titles start with AGENTS/plugin boilerplate; dropping the whole
 * message when its joined text starts with `<environment_context>` drops the
 * real prompt too. Keep user-authored parts and discard only known host
 * context parts. Page context may also prefix the real input in one part.
 */
export function codexUserText(content: unknown): string {
  if (typeof content === "string") {
    return stripInjectedCodexContext(content);
  }
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .map(stripInjectedCodexContext)
    .filter((text) => text.trim())
    .join("\n");
}

function stripInjectedCodexContext(text: string): string {
  // Strip only complete leading Page snapshots, preserving any prompt after
  // them and literal examples quoted later in user-authored text.
  const prompt = text.replace(
    /^(?:\s*<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>)+\s*/,
    "",
  );
  return isInjectedCodexContext(prompt) ? "" : prompt;
}

function isInjectedCodexContext(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<recommended_plugins>") ||
    /^# AGENTS\.md instructions for\s/.test(trimmed)
  );
}
