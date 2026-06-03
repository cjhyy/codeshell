import { describe, expect, it } from "bun:test";
import { statusForBucket } from "./sessionStatus";

const B = "repo1::s1";

describe("statusForBucket priority", () => {
  it("returns undefined when bucket is in none of the sets", () => {
    expect(statusForBucket(B, new Set(), new Set(), new Set())).toBeUndefined();
  });

  it("asking wins over running and unread", () => {
    expect(
      statusForBucket(B, new Set([B]), new Set([B]), new Set([B])),
    ).toBe("asking");
  });

  it("running wins over unread when not asking", () => {
    expect(
      statusForBucket(B, new Set(), new Set([B]), new Set([B])),
    ).toBe("running");
  });

  it("unread when only unread", () => {
    expect(statusForBucket(B, new Set(), new Set(), new Set([B]))).toBe("unread");
  });

  it("running on its own", () => {
    expect(statusForBucket(B, new Set(), new Set([B]), new Set())).toBe("running");
  });

  it("asking on its own", () => {
    expect(statusForBucket(B, new Set([B]), new Set(), new Set())).toBe("asking");
  });

  it("ignores other buckets' membership", () => {
    const other = "repo2::s9";
    expect(
      statusForBucket(B, new Set([other]), new Set([other]), new Set([other])),
    ).toBeUndefined();
  });
});
