import { expect, test } from "bun:test";
import { ExternalRuntimeProfileControl } from "./external-runtime-profile-control.js";

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("a committed reply interrupts after returning the tool result and completes once", async () => {
  let interrupted = 0;
  const control = new ExternalRuntimeProfileControl(
    6,
    () => true,
    async () => {
      interrupted++;
    },
  );
  expect(
    await control.runTool(async () => {
      control.runYield.request("reply_committed");
      return "accepted";
    }),
  ).toBe("accepted");
  expect(interrupted).toBe(0);
  await nextTick();
  expect(interrupted).toBe(1);
  expect(control.terminalReason("aborted_tools")).toBe("completed");
  await expect(control.runTool(async () => "repeat")).rejects.toThrow("already committed");
  await nextTick();
  expect(interrupted).toBe(1);
});

test("a manager's tool budget refuses the next invocation and terminates the provider", async () => {
  let invoked = 0,
    interrupted = 0;
  const control = new ExternalRuntimeProfileControl(
    2,
    () => true,
    async () => {
      interrupted++;
    },
  );
  await control.runTool(async () => {
    invoked++;
  });
  await control.runTool(async () => {
    invoked++;
  });
  await expect(
    control.runTool(async () => {
      invoked++;
    }),
  ).rejects.toThrow("limit");
  await nextTick();
  expect(invoked).toBe(2);
  expect(interrupted).toBe(1);
  expect(control.terminalReason("aborted_streaming")).toBe("max_turns");
});

test("a stale or user-cancelled turn cannot interrupt or relabel its successor", async () => {
  let current = true,
    interrupted = 0;
  const control = new ExternalRuntimeProfileControl(
    6,
    () => current,
    async () => {
      interrupted++;
    },
  );
  await control.runTool(async () => {
    control.runYield.request("reply_committed");
  });
  current = false;
  await nextTick();
  expect(interrupted).toBe(0);
  expect(control.terminalReason("aborted_streaming")).toBe("aborted_streaming");
});
