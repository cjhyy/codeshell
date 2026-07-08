import { describe, expect, test } from "bun:test";
import React from "react";
import { Text } from "../../render/index.js";
import type { ChatEntry } from "../store.js";
import { FullscreenModeContext } from "../fullscreen-mode.js";
import { VirtualMessageList, type VirtualMessageListHandle } from "./VirtualMessageList.js";
import { flush, mount } from "../../../../../tests/render-fixtures.js";

function entries(count: number): ChatEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    type: "assistant_text",
    text: `message ${i}`,
    streaming: false,
  }));
}

async function waitForHandle(getHandle: () => VirtualMessageListHandle | null) {
  for (let i = 0; i < 10; i++) {
    await flush();
    const handle = getHandle();
    if (handle) return handle;
  }
  throw new Error("VirtualMessageList handle was not attached");
}

describe("VirtualMessageList scroll-away notifications", () => {
  test("notifies when user scrolling breaks sticky bottom", async () => {
    let handle: VirtualMessageListHandle | null = null;
    let scrollAwayCalls = 0;
    const harness = mount(
      <FullscreenModeContext.Provider
        value={{ fullscreen: true, setFullscreen: () => {}, toggleFullscreen: () => {} }}
      >
        <VirtualMessageList
          ref={(r) => {
            handle = r;
          }}
          entries={entries(40)}
          renderEntry={(entry) => <Text>{entry.type}</Text>}
          columns={80}
          onScrollAway={() => {
            scrollAwayCalls++;
          }}
        />
      </FullscreenModeContext.Provider>,
      { columns: 80, rows: 16 },
    );

    try {
      const list = await waitForHandle(() => handle);

      list.scrollBy(-3);
      await flush();

      expect(scrollAwayCalls).toBe(1);
    } finally {
      harness.unmount();
    }
  });
});
