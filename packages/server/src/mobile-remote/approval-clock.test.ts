import { expect, test } from "bun:test";
import { stampApprovalClock } from "./approval-clock";
test("every approval delivery gets a current Host timestamp without moving its durable deadline", () => {
  const line = JSON.stringify({
    method: "agent/approvalRequest",
    params: { requestId: "a", expiresAt: 600000, request: { toolName: "Read" } },
  });
  expect(JSON.parse(stampApprovalClock(line, 1000))).toMatchObject({
    serverTime: 1000,
    params: { expiresAt: 600000 },
  });
  expect(JSON.parse(stampApprovalClock(stampApprovalClock(line, 1000), 50000))).toMatchObject({
    serverTime: 50000,
    params: { expiresAt: 600000 },
  });
  for (const other of [
    "not json",
    '{"method":"agent/output"}',
    '{"method":"agent/approvalRequest","params":{}}',
  ])
    expect(stampApprovalClock(other, 100)).toBe(other);
});
