import { afterAll, expect, test } from "bun:test";
import React from "react";
import type { QuestionDraft } from "../../../packages/tui/src/ui/pending-questions.ts";

const originalFetch = globalThis.fetch;
let outboundAttempts = 0;
globalThis.fetch = (async () => {
  outboundAttempts++;
  throw new Error("This pipe-only question fixture has no network access");
}) as typeof fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
const { mount, flush } = await import("../../../tests/render-fixtures.ts");
const { AskUserPrompt } = await import("../../../packages/tui/src/ui/components/AskUserPrompt.tsx");
const choices = [
  { label: "Core", description: "Review engine implementation" },
  { label: "Web", description: "Review browser client" },
];

async function selectSecondOption(batch: boolean) {
  let draft: QuestionDraft | undefined;
  const answers: string[] = [];
  const harness = mount(<AskUserPrompt
    question="Which modules should be reviewed?"
    options={choices}
    multiSelect
    onDraftChange={(value) => { draft = value; }}
    onAnswer={(answer) => { answers.push(answer); }}
    onCancel={() => { throw new Error("No cancellation is requested"); }}
  />);
  try {
    await flush();
    if (batch) {
      // A single ordinary terminal data chunk containing Down then Space.
      harness.stdin.write("\u001b[B ");
      await flush();
    } else {
      harness.stdin.write("\u001b[B");
      await flush();
      harness.stdin.write(" ");
      await flush();
    }
    expect(draft?.cursor).toBe(1);
    const selected = [...(draft?.selected ?? [])];
    harness.stdin.write("\u001b[13u");
    await flush();
    expect(draft?.phase).toBe("review");
    harness.stdin.write("\u001b[13u");
    await flush();
    expect(answers).toHaveLength(1);
    return { selected, answers };
  } finally {
    harness.unmount();
  }
}

test("Down + Space in one input chunk toggles the previous row and submits that row", async () => {
  const result = await selectSecondOption(true);
  expect(result.selected).toEqual([0]);
  expect(result.answers).toEqual(["Core"]);
  expect(outboundAttempts).toBe(0);
});

test("the same keys separated by a render toggle and submit the intended second row", async () => {
  const result = await selectSecondOption(false);
  expect(result.selected).toEqual([1]);
  expect(result.answers).toEqual(["Web"]);
  expect(outboundAttempts).toBe(0);
});
