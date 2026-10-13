import { expect, test } from "bun:test";
import { createComputerUseSettingsApi } from "./computer-use-api";

test("computer use preload offers only bounded desktop setup channels", async () => {
  const calls: unknown[][] = [];
  const api = createComputerUseSettingsApi({
    invoke: async (...args) => {
      calls.push(args);
    },
  });
  await api.status();
  await api.setEnabled(true);
  await api.requestPermission("screenRecording");
  await api.openSettings("accessibility");
  await api.restart();
  expect(calls).toEqual([
    ["computerUse:status"],
    ["computerUse:setEnabled", true],
    ["computerUse:requestPermission", "screenRecording"],
    ["computerUse:openSettings", "accessibility"],
    ["computerUse:restart"],
  ]);
  expect(Object.keys(api).sort()).toEqual([
    "openSettings",
    "requestPermission",
    "restart",
    "setEnabled",
    "status",
  ]);
});
