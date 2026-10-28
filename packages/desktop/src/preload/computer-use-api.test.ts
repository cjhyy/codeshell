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
  await api.setCompanion({ enabled: true, size: 320 });
  await api.previewCompanion();
  await api.setCompanionChatActive?.(true);
  expect(calls).toEqual([
    ["computerUse:status"],
    ["computerUse:setEnabled", true],
    ["computerUse:requestPermission", "screenRecording"],
    ["computerUse:openSettings", "accessibility"],
    ["computerUse:restart"],
    ["computerUse:setCompanion", { enabled: true, size: 320 }],
    ["computerUse:previewCompanion"],
    ["mimiCompanion:chatActive", true],
  ]);
  expect(Object.keys(api).sort()).toEqual([
    "openSettings",
    "previewCompanion",
    "requestPermission",
    "restart",
    "setCompanion",
    "setCompanionChatActive",
    "setEnabled",
    "status",
  ]);
});
