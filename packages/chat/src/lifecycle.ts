import type { ChannelMessage, ChannelMessageHandler } from "./channel.js";

export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

export function formatOutgoingMarkdown(
  text: string,
  button?: { text: string; url: string },
): string {
  return button ? `${text}\n\n[${button.text.replaceAll("]", "\\]")}](${button.url})` : text;
}

export async function dispatchSafely(
  handler: ChannelMessageHandler,
  message: ChannelMessage,
): Promise<void> {
  try {
    await handler(message);
  } catch (error) {
    console.error(
      `[chat] ${message.channel} 消息处理失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
