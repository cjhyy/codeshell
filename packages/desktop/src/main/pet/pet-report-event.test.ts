import { describe, expect, test } from "bun:test";
import { parsePetReportToMimiEvent } from "./pet-report-event.js";

const VALID_REPORT = {
  reportId: "a".repeat(32),
  sessionId: "pet-work-806bb2404fc122889366de82",
  message: " ready ",
  attachmentPaths: ["/Users/admin/Downloads/pet-comic-v2.png"],
  createdAt: 1,
};

describe("parsePetReportToMimiEvent", () => {
  test("accepts the exact bounded host notification", () => {
    expect(parsePetReportToMimiEvent(VALID_REPORT)).toEqual({
      ...VALID_REPORT,
      message: "ready",
    });
  });

  test("accepts reports from an ordinary Session", () => {
    expect(
      parsePetReportToMimiEvent({ ...VALID_REPORT, sessionId: "ordinary-session" }),
    ).toMatchObject({ sessionId: "ordinary-session" });
  });

  test("rejects unknown routing fields and invalid attachment paths", () => {
    expect(parsePetReportToMimiEvent({ ...VALID_REPORT, target: "wechat-owner" })).toBeNull();
    expect(
      parsePetReportToMimiEvent({ ...VALID_REPORT, attachmentPaths: ["~/pet-comic-v2.png"] }),
    ).toBeNull();
    expect(
      parsePetReportToMimiEvent({
        ...VALID_REPORT,
        attachmentPaths: ["/tmp/a.png", "/tmp/a.png"],
      }),
    ).toBeNull();
    expect(parsePetReportToMimiEvent({ ...VALID_REPORT, sessionId: " bad-session " })).toBeNull();
  });
});
