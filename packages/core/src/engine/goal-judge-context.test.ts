import { describe, expect, it } from "bun:test";
import type { Message } from "../types.js";
import { buildGoalJudgeRuntimeContext } from "./goal-judge-context.js";

function textRound(index: number): Message[] {
  return [
    { role: "assistant", content: `assistant-${index}` },
    { role: "user", content: `user-${index}` },
  ];
}

describe("buildGoalJudgeRuntimeContext", () => {
  it("renders user and assistant text in source order", () => {
    const context = buildGoalJudgeRuntimeContext([
      { role: "user", content: "first user" },
      { role: "assistant", content: "then assistant" },
    ]);

    expect(context.renderedConversation.indexOf("USER:\nfirst user")).toBeLessThan(
      context.renderedConversation.indexOf("ASSISTANT:\nthen assistant"),
    );
  });

  it("keeps tool_use and tool_result metadata together in one API round", () => {
    const context = buildGoalJudgeRuntimeContext([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "/tmp/a" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "file body", is_error: true },
        ],
      },
    ]);

    expect(context.selectedRoundCount).toBe(1);
    expect(context.renderedConversation).toContain(
      'ASSISTANT TOOL_USE id=tool-1 name=Read input={"path":"/tmp/a"}',
    );
    expect(context.renderedConversation).toContain(
      "TOOL_RESULT tool_use_id=tool-1 error=true:\nfile body",
    );
  });

  it("keeps only the newest N complete rounds in their original order", () => {
    const messages = Array.from({ length: 5 }, (_, index) => textRound(index + 1)).flat();
    const context = buildGoalJudgeRuntimeContext(messages, { maxRounds: 3 });

    expect(context.sourceRoundCount).toBe(5);
    expect(context.selectedRoundCount).toBe(3);
    expect(context.truncated).toBe(true);
    expect(context.renderedConversation).not.toContain("assistant-1");
    expect(context.renderedConversation).not.toContain("assistant-2");
    expect(context.renderedConversation.indexOf("assistant-3")).toBeLessThan(
      context.renderedConversation.indexOf("assistant-5"),
    );
  });

  it("drops an oldest whole round before splitting a tool pair for the character budget", () => {
    const messages: Message[] = [
      ...textRound(1),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "pair", name: "Check", input: { value: "x" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "pair", content: "PASS" }],
      },
    ];
    const latestOnly = buildGoalJudgeRuntimeContext(messages.slice(2));
    const context = buildGoalJudgeRuntimeContext(messages, {
      maxChars: latestOnly.chars + 5,
      maxEstimatedTokens: 10_000,
    });

    expect(context.selectedRoundCount).toBe(1);
    expect(context.renderedConversation).not.toContain("assistant-1");
    expect(context.renderedConversation).toContain("TOOL_USE id=pair");
    expect(context.renderedConversation).toContain("TOOL_RESULT tool_use_id=pair");
  });

  it("emergency-truncates one oversized newest round within the hard limit", () => {
    const context = buildGoalJudgeRuntimeContext(
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "A".repeat(4_000) },
            { type: "tool_use", id: "huge", name: "Bash", input: { command: "x".repeat(4_000) } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "huge", content: "R".repeat(4_000) }],
        },
      ],
      { maxChars: 900, maxEstimatedTokens: 250 },
    );

    expect(context.chars).toBeLessThanOrEqual(900);
    expect(context.estimatedTokens).toBeLessThanOrEqual(250);
    expect(context.renderedConversation).toContain("[truncated for goal judge; originalChars=");
    expect(context.renderedConversation).toContain("TOOL_USE id=huge name=Bash");
    expect(context.renderedConversation).toContain("TOOL_RESULT tool_use_id=huge");
  });

  it("removes nested image base64 payloads while retaining image metadata", () => {
    const payload = "a".repeat(256);
    const context = buildGoalJudgeRuntimeContext([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "image-tool",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: payload },
              },
            ],
          },
        ],
      },
    ]);

    expect(context.renderedConversation).not.toContain(payload);
    expect(context.renderedConversation).toContain("image/png");
    expect(context.renderedConversation).toContain("omitted");
  });

  it("uses the redaction-map replacement instead of sensitive tool plaintext", () => {
    const context = buildGoalJudgeRuntimeContext(
      [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "credential", content: "TOP_SECRET_VALUE" },
          ],
        },
      ],
      {
        sensitiveToolResultRedactions: new Map([["credential", "[credential value withheld]"]]),
      },
    );

    expect(context.renderedConversation).not.toContain("TOP_SECRET_VALUE");
    expect(context.renderedConversation).toContain("[credential value withheld]");
  });

  it("omits reasoning content", () => {
    const context = buildGoalJudgeRuntimeContext([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "hidden chain", reasoningContent: "provider secret chain" },
          { type: "text", text: "visible answer" },
        ],
      },
    ]);

    expect(context.renderedConversation).toContain("[reasoning omitted]");
    expect(context.renderedConversation).not.toContain("hidden chain");
    expect(context.renderedConversation).not.toContain("provider secret chain");
  });

  it("produces a stable digest that changes with a tool result", () => {
    const make = (result: string) =>
      buildGoalJudgeRuntimeContext([
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: result }],
        },
      ]);

    expect(make("A").digest).toBe(make("A").digest);
    expect(make("A").digest).not.toBe(make("B").digest);
    expect(make("A").digest).toMatch(/^[a-f0-9]{16}$/);
  });

  it("returns an explicit empty-conversation marker", () => {
    const context = buildGoalJudgeRuntimeContext([]);

    expect(context.renderedConversation).toBe("(无最近对话)");
    expect(context.sourceRoundCount).toBe(0);
    expect(context.selectedRoundCount).toBe(0);
    expect(context.truncated).toBe(false);
  });
});
