import { describe, it, expect } from "bun:test";
import {
  askUserTool,
  askUserToolDef,
  askUserAsyncTool,
  askUserAsyncToolDef,
} from "./ask-user.js";
import type { ToolContext, AskUserOptions } from "../context.js";

/** Capture the args askUser was called with, return a canned answer. */
function ctxWith(
  answer: string | Promise<string> | (() => Promise<string>),
  handler: "askUser" | "askUserAsync" = "askUser",
): {
  ctx: ToolContext;
  lastOpts: () => AskUserOptions | undefined;
  lastQuestion: () => string;
} {
  let opts: AskUserOptions | undefined;
  let question = "";
  const ctx = {
    [handler]: (q: string, o?: AskUserOptions) => {
      question = q;
      opts = o;
      return typeof answer === "function" ? answer() : Promise.resolve(answer);
    },
  } as unknown as ToolContext;
  return { ctx, lastOpts: () => opts, lastQuestion: () => question };
}

describe("askUserTool", () => {
  it("requires a question", async () => {
    const { ctx } = ctxWith("x");
    expect(await askUserTool({}, ctx)).toContain("question is required");
  });

  it("errors in headless mode (no askUser in ctx)", async () => {
    expect(await askUserTool({ question: "ok?" }, {} as ToolContext)).toContain("headless mode");
  });

  it("forwards a free-text question and returns the answer", async () => {
    const { ctx, lastOpts, lastQuestion } = ctxWith("blue");
    const out = await askUserTool({ question: "favorite color?" }, ctx);
    expect(out).toBe("blue");
    expect(lastQuestion()).toBe("favorite color?");
    expect(lastOpts()).toBeUndefined(); // no header/options/multiSelect
  });

  it("parses multiple-choice options + header + multiSelect", async () => {
    const { ctx, lastOpts } = ctxWith("A");
    await askUserTool(
      {
        question: "pick",
        header: "Approach",
        multiSelect: true,
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
      },
      ctx,
    );
    const o = lastOpts();
    expect(o?.header).toBe("Approach");
    expect(o?.multiSelect).toBe(true);
    expect(o?.options).toEqual([
      { label: "A", description: "first" },
      { label: "B", description: "second" },
    ]);
  });

  it("strips a model-supplied `tone` so LLM prompts can't self-color (stays neutral)", async () => {
    const { ctx, lastOpts } = ctxWith("A");
    await askUserTool(
      {
        question: "pick",
        options: [
          { label: "A", description: "first", tone: "ok" },
          { label: "B", description: "second", tone: "danger" },
        ],
      },
      ctx,
    );
    // Only label/description survive — no tone key on any option.
    expect(lastOpts()?.options).toEqual([
      { label: "A", description: "first" },
      { label: "B", description: "second" },
    ]);
    for (const o of lastOpts()?.options ?? []) {
      expect("tone" in o).toBe(false);
    }
  });

  it("drops malformed options (missing label/description)", async () => {
    const { ctx, lastOpts } = ctxWith("x");
    await askUserTool(
      { question: "pick", options: [{ label: "A" }, { description: "no label" }, 42] },
      ctx,
    );
    expect(lastOpts()?.options).toBeUndefined(); // none valid → undefined
  });

  it("reports an empty user response distinctly", async () => {
    const { ctx } = ctxWith("");
    expect(await askUserTool({ question: "q" }, ctx)).toContain("empty response");
  });

  it("surfaces an askUser rejection as an error string", async () => {
    const { ctx } = ctxWith(() => Promise.reject(new Error("cancelled")));
    expect(await askUserTool({ question: "q" }, ctx)).toContain("Error asking user: cancelled");
  });
});

describe("askUserAsyncTool", () => {
  it("requires a nonempty string question", async () => {
    const { ctx } = ctxWith("displayed", "askUserAsync");
    for (const args of [{}, { question: 42 }, { question: " " }]) {
      expect(await askUserAsyncTool(args, ctx)).toContain("question is required");
    }
  });

  it("never falls back to the blocking handler when async delivery is unsupported", async () => {
    let asked = false;
    const { ctx } = ctxWith(async () => {
      asked = true;
      return "answer";
    });
    expect(await askUserAsyncTool({ question: "theme?" }, ctx)).toContain(
      "No question was displayed",
    );
    expect(asked).toBe(false);
  });

  it("returns the delivery receipt and forwards a plain question", async () => {
    const { ctx, lastQuestion, lastOpts } = ctxWith("Question q1 displayed", "askUserAsync");
    expect(await askUserAsyncTool({ question: "theme?" }, ctx)).toBe("Question q1 displayed");
    expect(lastQuestion()).toBe("theme?");
    expect(lastOpts()).toBeUndefined();
  });

  it("shares the input schema and strips untrusted option rendering hints", async () => {
    expect(askUserAsyncToolDef.inputSchema).toBe(askUserToolDef.inputSchema);
    const { ctx, lastOpts } = ctxWith("displayed", "askUserAsync");
    await askUserAsyncTool(
      {
        question: "请选择配色",
        header: "配色",
        multiSelect: true,
        optionsOnly: true,
        options: [
          { label: "蓝色", description: "冷色", tone: "ok" },
          { label: "红色", description: "暖色", tone: "danger" },
          { label: "invalid" },
        ],
      },
      ctx,
    );
    expect(lastOpts()).toEqual({
      header: "配色",
      multiSelect: true,
      options: [
        { label: "蓝色", description: "冷色" },
        { label: "红色", description: "暖色" },
      ],
    });
  });

  it("does not label an empty receipt as an empty user answer", async () => {
    const { ctx } = ctxWith("", "askUserAsync");
    expect(await askUserAsyncTool({ question: "theme?" }, ctx)).toContain(
      "no answer has been received",
    );
  });

  it("surfaces delivery failures without claiming the user answered", async () => {
    const { ctx } = ctxWith(() => Promise.reject(new Error("connection closed")), "askUserAsync");
    expect(await askUserAsyncTool({ question: "theme?" }, ctx)).toBe(
      "Error displaying question: connection closed",
    );
  });
});
