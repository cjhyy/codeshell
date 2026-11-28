import { expect, mock, test } from "bun:test";
import { readWhenHostBusy } from "./readWhenHostBusy";

test("leaving a congested project cancels its wait before another read", async () => {
  const controller = new AbortController();
  const read = mock(async () => {
    throw Error("Too many pending Desktop Host requests (-32001)");
  });
  const result = readWhenHostBusy(read, controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(result).rejects.toHaveProperty("name", "AbortError");
  expect(read).toHaveBeenCalledTimes(1);
});

test("other failures using the same RPC code reach the caller", async () => {
  const error = Error("Project not found (-32001)");
  const read = mock(async () => {
    throw error;
  });
  await expect(readWhenHostBusy(read, new AbortController().signal)).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
});
