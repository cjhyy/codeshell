import { expect, test } from "bun:test";
import React from "react";
import { StatusLine } from "./StatusLine.js";
import { flush, mount, plainText } from "../../../../../tests/render-fixtures.js";

test("terminal footer retains unknown and partial cost evidence instead of formatting it as zero", async () => {
  const harness = mount(
    <StatusLine
      model="gpt-4o"
      effort="high"
      tokens={120}
      cost="~$0.000000 + 2 unknown (partial)"
    />,
  );
  try {
    await flush();
    expect(plainText(harness)).toContain("2 unknown");
    expect(plainText(harness)).toContain("partial");
    expect(plainText(harness)).not.toContain("$0.00 │");
  } finally {
    harness.unmount();
  }
});
