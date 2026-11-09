import { describe, expect, test } from "bun:test";
import {
  buildCompactDelegationBrief,
  buildDelegationBrief,
  stripDelegationBrief,
} from "./delegation-brief.js";

describe("delegation brief", () => {
  test("names the IM channel the owner asked from", () => {
    expect(buildDelegationBrief({ origin: "im", channelLabel: "WeChat" })).toBe(
      [
        "[Delegated by Mimi]",
        "Mimi started this Session for the owner from WeChat. The owner may be away from the computer.",
        "- When you need a decision, use AskUserQuestionAsync with concrete options, mark one recommended, and set skippable.",
        "- The host reports completion automatically; do not call RequestMimiDelivery at the end.",
        "- Use ReportToMimi only for a milestone the owner would want before completion.",
        "[/Delegated by Mimi]",
      ].join("\n"),
    );
  });

  test("a desktop delegation says the desktop; an IM one without a label stays generic", () => {
    expect(buildDelegationBrief({ origin: "desktop", channelLabel: "飞书" })).toContain(
      "for the owner from the desktop.",
    );
    expect(buildDelegationBrief({ origin: "im" })).toContain("for the owner from a chat app.");
    expect(buildDelegationBrief({ origin: "im", channelLabel: " 飞书\n" })).toContain(
      "for the owner from 飞书.",
    );
  });

  test("strip removes a leading brief, full or compact, and nothing else", () => {
    const objective = "Fix the login page.\n\nKeep the old API.";
    expect(
      stripDelegationBrief(`${buildDelegationBrief({ origin: "desktop" })}\n\n${objective}`),
    ).toBe(objective);
    expect(
      stripDelegationBrief(`  ${buildCompactDelegationBrief({ origin: "im" })}\n\n${objective}`),
    ).toBe(objective);
    expect(stripDelegationBrief(objective)).toBe(objective);
    const quoted = `Explain this: [Delegated by Mimi] x [/Delegated by Mimi]`;
    expect(stripDelegationBrief(quoted)).toBe(quoted);
    // A brief cut by a length bound before it closes is all brief.
    expect(stripDelegationBrief("[Delegated by Mimi]\nMimi started this Sess")).toBe("");
  });
});
