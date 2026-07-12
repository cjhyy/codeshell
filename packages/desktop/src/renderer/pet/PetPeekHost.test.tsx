import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetPeekHost } from "./PetPeekHost";

describe("PetPeekHost", () => {
  test("renders a keyboard action and a separate close button without approval controls", () => {
    const html = renderToStaticMarkup(
      <PetPeekHost
        peeks={[
          {
            id: "peek-1",
            title: "Work A 等你决定",
            detail: "需要回答",
            receiptKeys: ["receipt-1"],
            action: {
              type: "open_session",
              target: { agentSessionId: "work-a", snapshotVersion: 4, generation: 2 },
            },
          },
        ]}
        onAction={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(html).toContain('data-pet-peek-stack="bottom-right"');
    expect(html).toContain("打开并处理");
    expect(html).toContain("关闭提醒");
    expect(html).not.toContain("批准");
    expect(html).not.toContain("拒绝");
  });
});
