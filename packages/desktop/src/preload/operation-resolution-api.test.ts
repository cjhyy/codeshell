import { expect, test } from "bun:test";
import { createOperationResolutionApi } from "./operation-resolution-api.js";

test("native review bridge forwards only masked review and fixed operation capabilities", async () => {
  const calls: unknown[][] = [];
  const api = createOperationResolutionApi({
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "cancelled" };
    },
  });
  const input = {
    reviewToken: "native-preview",
    operationId: "original-id",
    revision: "original-revision",
  };
  await api.review("session");
  await api.reconcile(input);
  await api.resolve(input);
  expect(calls).toEqual([
    ["operationResolution:review", { sessionId: "session" }],
    ["operationResolution:reconcile", input],
    ["operationResolution:resolve", input],
  ]);
});
