const MAX_CONVERSATION_CHARS = 30_000;
const MESSAGE_OMISSION = "\n[... middle of message omitted ...]\n";
const CONVERSATION_OMISSION = "[... earlier conversation omitted ...]";

/** Keep the original intent and recent outcomes inside the memory prompt budget. */
export function formatMemoryTranscript(
  messages: Array<{ role: string; content: string }>,
  maxMessageChars: number,
): string {
  const parts = messages.map(({ role, content }) => {
    if (content.length > maxMessageChars) {
      const headChars = Math.ceil((maxMessageChars - MESSAGE_OMISSION.length) / 2);
      const tailChars = maxMessageChars - MESSAGE_OMISSION.length - headChars;
      content = `${content.slice(0, headChars)}${MESSAGE_OMISSION}${content.slice(-tailChars)}`;
    }
    return `[${role}]: ${content}`;
  });
  const size = parts.reduce((length, part, index) => length + part.length + (index ? 2 : 0), 0);
  if (size <= MAX_CONVERSATION_CHARS) return parts.join("\n\n");

  const first = parts[0]!;
  let remaining = MAX_CONVERSATION_CHARS - first.length - CONVERSATION_OMISSION.length - 4;
  let start = parts.length;
  for (let index = parts.length - 1; index > 0; index--) {
    const needed = parts[index]!.length + (start < parts.length ? 2 : 0);
    if (needed > remaining) break;
    remaining -= needed;
    start = index;
  }
  return [first, CONVERSATION_OMISSION, ...parts.slice(start)].join("\n\n");
}
