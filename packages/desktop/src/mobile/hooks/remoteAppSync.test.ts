import { describe, expect, test } from "bun:test";
import { rawApprovalResolvedRequestId, removeResolvedApproval } from "./remoteAppSync";

describe("mobile remote app sync helpers", () => {
  test("raw agent/approvalResolved extracts requestId and clears only that card", () => {
    const requestId = rawApprovalResolvedRequestId({
      method: "agent/approvalResolved",
      params: { requestId: "ask-1", sessionId: "s1" },
    });

    expect(requestId).toBe("ask-1");
    expect(
      removeResolvedApproval(
        [
          { requestId: "ask-1", label: "old" },
          { requestId: "ask-2", label: "keep" },
        ],
        requestId!,
      ),
    ).toEqual([{ requestId: "ask-2", label: "keep" }]);
  });
});
