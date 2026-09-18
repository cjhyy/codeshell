import { expect, test } from "bun:test";
import React from "react";
import { flush, mount, plainText } from "../../../../../tests/render-fixtures.js";
import { Text } from "../../render/index.js";
import type { QuestionDraft } from "../pending-questions.js";
import { AskUserPrompt } from "./AskUserPrompt.js";

const options = [
  { label: "One", description: "First choice" },
  { label: "Two", description: "Second choice" },
];
const reviewed: QuestionDraft = {
  phase: "review",
  cursor: 0,
  selected: [],
  inputValue: "",
  reviewCursor: 0,
};

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!assertion() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(assertion()).toBe(true);
}

test("consecutive Enter keys submit once and block other decisions until the result arrives", async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let answers = 0;
  let cancelled = 0;
  let deferred = 0;
  let drafts = 0;
  const harness = mount(
    <AskUserPrompt
      question="Choose"
      options={options}
      draft={reviewed}
      onAnswer={() => {
        answers++;
        return pending;
      }}
      onCancel={() => {
        cancelled++;
      }}
      onDefer={() => {
        deferred++;
      }}
      onDraftChange={() => {
        drafts++;
      }}
    />,
  );
  try {
    await flush();
    harness.stdin.write("\u001b[13u");
    harness.stdin.write("\u001b[13u");
    harness.stdin.write("\u001b[27u");
    await flush();
    expect(answers).toBe(1);
    expect(cancelled).toBe(0);
    expect(deferred).toBe(0);
    expect(drafts).toBe(0);
    complete();
    await flush();
    harness.stdin.write("\u001b[13u");
    await flush();
    expect(answers).toBe(1);
  } finally {
    harness.unmount();
  }
});

test("failed submission unlocks the reviewed draft for a single retry", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  let answers = 0;
  const harness = mount(
    <AskUserPrompt
      question="Choose"
      options={options}
      draft={reviewed}
      onAnswer={() => {
        answers++;
        return answers === 1 ? pending : Promise.resolve();
      }}
      onCancel={() => {}}
    />,
  );
  try {
    await flush();
    harness.stdin.write("\u001b[13u");
    harness.stdin.write("\u001b[13u");
    await flush();
    expect(answers).toBe(1);
    reject(new Error("temporary failure"));
    await flush();
    harness.stdin.write("\u001b[13u");
    harness.stdin.write("\u001b[13u");
    await flush();
    expect(answers).toBe(2);
  } finally {
    harness.unmount();
  }
});

test("a remounted question remains locked while its original submission is pending", async () => {
  let answers = 0;
  let deferred = 0;
  const prompt = (submitting: boolean) => (
    <AskUserPrompt
      question="Choose"
      options={options}
      draft={reviewed}
      submitting={submitting}
      onAnswer={() => {
        answers++;
      }}
      onCancel={() => {}}
      onDefer={() => {
        deferred++;
      }}
    />
  );
  const harness = mount(prompt(true));
  try {
    await flush();
    harness.stdin.write("\u001b[13u\u001b[27u");
    await flush();
    expect(answers).toBe(0);
    expect(deferred).toBe(0);
    harness.instance.rerender(prompt(false));
    await flush();
    harness.stdin.write("\u001b[13u");
    await flush();
    expect(answers).toBe(1);
  } finally {
    harness.unmount();
  }
});

test("deferred multi-select and free-text drafts restore after the prompt remounts", async () => {
  let saved: QuestionDraft | undefined;
  let deferred = 0;
  const answers: string[] = [];
  const prompt = () => (
    <AskUserPrompt
      question="Choose"
      options={options}
      multiSelect
      draft={saved}
      onDraftChange={(draft) => {
        saved = draft;
      }}
      onDefer={() => {
        deferred++;
      }}
      onAnswer={(answer) => {
        answers.push(answer);
      }}
      onCancel={() => {}}
    />
  );
  const harness = mount(prompt());
  try {
    await flush();
    harness.stdin.write(" ");
    await flush();
    harness.stdin.write("\u001b[B");
    await flush();
    harness.stdin.write(" ");
    await flush();
    harness.stdin.write("\u001b[B");
    await flush();
    harness.stdin.write("custom detail");
    await flush();
    harness.stdin.write("\u001b[27u");
    await flush();
    expect(deferred).toBe(1);
    expect(saved).toMatchObject({
      phase: "pick",
      cursor: 2,
      selected: [0, 1],
      inputValue: "custom detail",
    });
    expect(answers).toHaveLength(0);
    harness.instance.rerender(<Text>Deferred</Text>);
    await flush();
    harness.instance.rerender(prompt());
    await flush();
    harness.stdin.write("\u001b[13u");
    await flush();
    expect(saved?.phase).toBe("review");
    await waitFor(() => plainText(harness).includes("Ready to submit your answers?"));
    harness.stdin.write("\u001b[13u");
    await flush();
    expect(answers).toEqual(["One, Two, Other: custom detail"]);
  } finally {
    harness.unmount();
  }
});
