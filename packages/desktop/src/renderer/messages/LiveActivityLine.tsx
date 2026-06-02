import type { Message } from "../types";
import { summarizeLiveActivity, describeActivity } from "../topbar/liveActivity";

/**
 * Inline "current activity" line shown at the bottom of the message
 * stream (Codex style), e.g. "正在读取 automationMemory.ts" /
 * "正在搜索 …" / "正在思考…". When the turn is actively running the text
 * gets a flowing shimmer effect (see `.cs-live-shimmer` in views.css);
 * when idle it's plain static grey text. No spinner icon.
 *
 * Pure presentational — no effects or state — so renderToStaticMarkup
 * can test it.
 */
export function LiveActivityLine({
  messages,
  running,
}: {
  messages: Message[];
  running: boolean;
}) {
  const activity = summarizeLiveActivity(messages);
  const text = describeActivity(activity);
  return (
    <div className="px-4 py-1 text-sm font-medium text-muted-foreground">
      <span className={running ? "cs-live-shimmer" : undefined}>{text}</span>
    </div>
  );
}
