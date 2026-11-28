import type { ChannelMessage, ChannelMessageHandler } from "./channel.js";

export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/**
 * Settle with `promise`, or early when `signal` aborts. Unlike racing against
 * waitForAbort, the abort listener is removed afterwards, so retry loops on a
 * long-lived gateway signal do not accumulate one listener per attempt.
 */
export async function raceAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
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
): Promise<boolean> {
  try {
    await handler(message);
    return true;
  } catch (error) {
    console.error(
      `[chat] ${message.channel} 消息处理失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
