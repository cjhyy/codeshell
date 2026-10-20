import { describe, expect, test } from "bun:test";
import { transcriptUserDisplay } from "@cjhyy/code-shell-web";
import { buildSessionHistory } from "./mobile-history.js";

const envelope =
  "look at this\n\n<attached-image-paths>\n/repo/.code-shell/attachments/s/0123456789abcdef-shot.png\n</attached-image-paths>\n(上面附带的图片在工作区的真实路径，如需把它们作为工具输入，直接使用这些路径。)";

describe("buildSessionHistory", () => {
  test("a legacy image input replays its text and an attachment summary, not the envelope", async () => {
    const events = await buildSessionHistory(
      "s",
      async () => [
        { kind: "user", text: envelope, images: 1 },
        { kind: "stream", event: { type: "text_delta", text: "a cat" } },
      ],
      transcriptUserDisplay,
    );
    expect(events[0]).toEqual({
      type: "user_message",
      text: "look at this",
      attachments: [
        {
          name: "shot.png",
          path: "/repo/.code-shell/attachments/s/0123456789abcdef-shot.png",
          size: 0,
        },
      ],
    });
    expect(JSON.stringify(events)).not.toContain("attached-image-paths");
    expect(events[1]).toEqual({ type: "text_delta", text: "a cat" });
  });

  test("text the user typed themselves is replayed verbatim", async () => {
    const typed = "please explain <attached-image-paths>x</attached-image-paths>";
    const events = await buildSessionHistory(
      "s",
      async () => [{ kind: "user", text: typed }],
      transcriptUserDisplay,
    );
    expect(events).toEqual([{ type: "user_message", text: typed }]);
  });
});
