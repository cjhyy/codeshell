import { describe, expect, test } from "bun:test";
import React from "react";
import { renderEntry } from "./App.js";
import type { ChatEntry } from "./store.js";
import { flush, mount, plainText } from "../../../../tests/render-fixtures.js";

function EntryHarness({ entry }: { entry: ChatEntry }) {
  return <>{renderEntry(entry, entry.id, false)}</>;
}

describe("renderEntry", () => {
  test("passes compact tool results through to ToolCallResult", async () => {
    const entry = {
      id: "tool-1",
      type: "tool_result",
      toolName: "Arena",
      result: "Arena error: participant endpoint mismatch",
      compact: true,
    } as ChatEntry;

    const harness = mount(<EntryHarness entry={entry} />, { columns: 100 });
    try {
      await flush();

      const output = plainText(harness);
      expect(output).toContain("Arena retried");
      expect(output).toContain("participant endpoint mismatch");
      expect(output).not.toContain("✓ Arena");
    } finally {
      harness.unmount();
    }
  });
});
