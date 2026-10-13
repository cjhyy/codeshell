import { expect, test } from "bun:test";
import { ToolRegistry } from "../../../../packages/core/src/tool-system/registry";
import { ToolExecutor } from "../../../../packages/core/src/tool-system/executor";
import { PermissionClassifier } from "../../../../packages/core/src/tool-system/permission";
import { HookRegistry } from "../../../../packages/core/src/hooks/registry";
import { StreamingToolQueue } from "../../../../packages/core/src/engine/streaming-tool-queue";

test("real GenerateImage queue reaches two simultaneous approval requests before either is answered", async () => {
  const requests: any[] = [];
  const pending: Array<() => void> = [];
  const registry = new ToolRegistry({ builtinTools: ["GenerateImage"] });
  const permission = new PermissionClassifier([], "default", {
    requestApproval: async (req) => {
      requests.push(req);
      return new Promise((resolve) =>
        pending.push(() =>
          resolve({ approved: false, reason: "review fixture denies without contacting provider" }),
        ),
      );
    },
  });
  const executor = new ToolExecutor(registry, permission, new HookRegistry());
  executor.setContext({ cwd: "/tmp", sessionId: "same-session" } as any);
  expect(executor.isConcurrencySafe("GenerateImage")).toBe(true);
  const queue = new StreamingToolQueue(executor);
  queue.enqueue({ id: "image-1", toolName: "GenerateImage", args: { prompt: "first test" } });
  queue.enqueue({ id: "image-2", toolName: "GenerateImage", args: { prompt: "second test" } });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(requests).toHaveLength(2);
  expect(requests.map((r) => r.toolName)).toEqual(["GenerateImage", "GenerateImage"]);
  pending.forEach((resolve) => resolve());
  const result = await queue.drain();
  expect(result.every((r) => r.isError)).toBe(true);
});
