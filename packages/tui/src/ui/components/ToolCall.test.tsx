import { expect, test } from "bun:test";
import React from "react";
import { ToolCallResult } from "./ToolCall.js";
import { flush, mount, plainText } from "../../../../../tests/render-fixtures.js";

async function renderResult(toolName: string, result: string): Promise<string> {
  const harness = mount(<ToolCallResult toolName={toolName} result={result} />);
  try {
    await flush();
    return plainText(harness);
  } finally {
    harness.unmount();
  }
}

test("Glob with no matches reports zero files and lists none", async () => {
  const text = await renderResult("Glob", "No files matched the pattern.");
  expect(text).toContain("Glob 0 files");
  expect(text).not.toContain("No files matched the pattern.");
});

test("Glob over the listing cap reports the total and hides the trailer row", async () => {
  const listed = Array.from({ length: 200 }, (_, i) => `f${i}.ts  (1B)`).join("\n");
  const text = await renderResult("Glob", `${listed}\n\n... and 5 more files (205 total)`);
  expect(text).toContain("Glob 205 files");
  expect(text).toContain("+197 lines");
});
