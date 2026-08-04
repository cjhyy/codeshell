import { describe, expect, test } from "bun:test";
import { petFollowUpId } from "./pet-follow-up-id";

describe("petFollowUpId", () => {
  test("is stable for one completion and changes when the same Session finishes again", () => {
    const first = petFollowUpId("private-session-id", 1_000);
    expect(first).toBe(petFollowUpId("private-session-id", 1_000));
    expect(first).not.toBe(petFollowUpId("private-session-id", 2_000));
    expect(first).not.toContain("private-session-id");
    expect(first).toMatch(/^followup-[A-Za-z0-9_-]{24}$/u);
  });

  test("rejects malformed source identity", () => {
    expect(() => petFollowUpId("", 1)).toThrow("invalid follow-up source identity");
    expect(() => petFollowUpId("session", Number.NaN)).toThrow("invalid follow-up source identity");
  });
});
