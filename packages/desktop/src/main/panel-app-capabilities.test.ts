import { expect, test } from "bun:test";
import { desktopPanelCapabilities } from "./panel-app-capabilities.js";

const options = {
  resources: { maxChunkBytes: 32768, materialize: true, capture: true },
  tasks: { durable: true },
  audio: false,
  cookies: true,
  automations: false,
  mediaMethods: ["media.assets.list"],
};

test("Desktop masks process hand-offs and durable tasks without both required permissions", () => {
  const restricted = desktopPanelCapabilities(
    ["resources", "credentials.connections", "credentials.cookies"],
    options,
  );
  expect(restricted.availableMethods).toContain("resources.read");
  expect(restricted.availableMethods).toContain("credentials.connections.list");
  expect(restricted.availableMethods).toContain("credentials.cookies.list");
  for (const method of [
    "process.spawn",
    "resources.materialize",
    "resources.capture",
    "tasks.start",
    "credentials.connections.authorizeProcess",
    "credentials.cookies.authorizeProcess",
  ])
    expect(restricted.availableMethods).not.toContain(method);
  expect(restricted.capabilities.resources).toMatchObject({
    maxChunkBytes: 32768,
    materialize: false,
    capture: false,
  });
  expect(restricted.capabilities.process).toBeUndefined();
  expect(restricted.capabilities.tasks).toBeUndefined();
  const processOnly = desktopPanelCapabilities(["process"], options);
  expect(processOnly.availableMethods).toContain("process.get");
  expect(processOnly.availableMethods).not.toContain("tasks.start");
  expect(processOnly.capabilities.resources).toBeUndefined();
  expect(processOnly.capabilities.tasks).toBeUndefined();
});

test("Desktop advertises only implemented services and the larger bounded protocol calls", () => {
  const value = desktopPanelCapabilities(
    [
      "resources",
      "process",
      "credentials.connections",
      "audio.transcribe",
      "automations.manage",
      "media",
    ],
    options,
  );
  for (const method of [
    "tasks.start",
    "tasks.get",
    "process.resolveEntry",
    "process.write",
    "process.end",
    "resources.materialize",
    "resources.capture",
    "credentials.connections.authorizeProcess",
  ])
    expect(value.availableMethods).toContain(method);
  expect(value.availableMethods).not.toContain("audio.transcribe");
  expect(value.availableMethods).not.toContain("automations.create");
  expect(value.availableMethods).toContain("media.assets.list");
  expect(value.availableMethods).not.toContain("media.tts");
  expect(value.capabilities.resources).toMatchObject({ materialize: true, capture: true });
  expect(value.capabilities.tasks).toEqual({ durable: true });
  expect(value.capabilities.methodLimits["tasks.start"]).toMatchObject({
    maxParamsBytes: 2 * 1024 * 1024 + 8192,
  });
  expect(value.capabilities.methodLimits["process.get"]).toMatchObject({
    maxResultBytes: 2 * 1024 * 1024,
  });
  expect(value.capabilities.methodLimits["process.write"]).toMatchObject({
    maxParamsBytes: 128 * 1024,
  });
  const noQueue = desktopPanelCapabilities(["resources", "process"], {
    ...options,
    tasks: undefined,
  });
  expect(noQueue.availableMethods).not.toContain("tasks.start");
  expect(noQueue.capabilities.tasks).toBeUndefined();
});
