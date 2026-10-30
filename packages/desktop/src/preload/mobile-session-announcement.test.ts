import { expect, test } from "bun:test";
import { normalizeMobileSessionAnnouncement } from "./mobile-session-announcement";

test.each(["default", "acceptEdits", "bypassPermissions"])(
  "mobile announcement forwards the explicit %s permission without extra fields",
  (permissionMode) => {
    const announcement = {
      sessionId: "mobile-owned",
      cwd: "/owned/project",
      title: "Owned title",
      prompt: "Owned prompt",
      clientMessageId: "owned-input",
      permissionMode,
    };
    expect(normalizeMobileSessionAnnouncement({ ...announcement, extra: "ignored" })).toEqual(
      announcement,
    );
  },
);

test("older announcements keep optional permission absent and invalid modes cannot grant it", () => {
  const expected = { sessionId: "mobile-owned", cwd: "", title: "", prompt: "" };
  expect(normalizeMobileSessionAnnouncement({ sessionId: "mobile-owned" })).toEqual(expected);
  for (const permissionMode of [null, "bypass", "plan", {}, 1]) {
    expect(
      normalizeMobileSessionAnnouncement({ sessionId: "mobile-owned", permissionMode }),
    ).toEqual(expected);
  }
  for (const value of [null, [], {}, { sessionId: 1 }, { sessionId: "" }]) {
    expect(normalizeMobileSessionAnnouncement(value)).toBeNull();
  }
});
