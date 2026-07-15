import { describe, expect, test } from "bun:test";
import { mobileTranscriptSubscriberId } from "./viewer-identity";

describe("mobileTranscriptSubscriberId", () => {
  test("keeps two viewers from the same device independent", () => {
    expect(mobileTranscriptSubscriberId("viewer-1")).toBe("mobile:viewer-1");
    expect(mobileTranscriptSubscriberId("viewer-2")).toBe("mobile:viewer-2");
    expect(mobileTranscriptSubscriberId("viewer-1")).not.toBe(
      mobileTranscriptSubscriberId("viewer-2"),
    );
  });
});
