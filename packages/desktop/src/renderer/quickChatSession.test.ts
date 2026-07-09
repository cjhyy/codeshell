import { describe, expect, test } from "bun:test";
import {
  isQuickChatBucket,
  isQuickChatSessionId,
  makeQuickChatSessionId,
  quickChatBucket,
  quickChatSessionIdFromBucket,
  quickChatTabKey,
} from "./quickChatSession";

describe("quickChatSession", () => {
  test("creates safe temporary engine session ids", () => {
    const id = makeQuickChatSessionId();

    expect(id).toMatch(/^qchat-[A-Za-z0-9.-]+$/);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(isQuickChatSessionId(id)).toBe(true);
    expect(id.includes("/")).toBe(false);
    expect(id.includes("\\")).toBe(false);
    expect(id.includes("..")).toBe(false);
  });

  test("maps quick chat sessions to their own bucket namespace", () => {
    const bucket = quickChatBucket("qchat-test-123");

    expect(bucket).toBe("__quick_chat__::qchat-test-123");
    expect(isQuickChatBucket(bucket)).toBe(true);
    expect(quickChatSessionIdFromBucket(bucket)).toBe("qchat-test-123");
    expect(isQuickChatBucket("r-1::s-main")).toBe(false);
    expect(quickChatSessionIdFromBucket("r-1::s-main")).toBeNull();
  });

  test("keys quick chat tabs by owner bucket and tab id", () => {
    expect(quickChatTabKey("r-1::s-main", "quickChat-7")).toBe("r-1::s-main@@quickChat-7");
  });
});
