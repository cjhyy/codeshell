import { expect, test } from "bun:test";
import { desktopPanelCapabilities } from "./panel-app-capabilities.js";

const options = {
  resources: {
    maxChunkBytes: 32768,
    materialize: true,
    capture: true,
    externalReferences: true,
    createReferences: true,
  },
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
  expect(restricted.availableMethods).toContain("resources.references.pick");
  expect(restricted.availableMethods).toContain("resources.references.get");
  expect(restricted.availableMethods).toContain("resources.references.forget");
  expect(restricted.availableMethods).toContain("credentials.connections.list");
  expect(restricted.availableMethods).toContain("credentials.cookies.list");
  for (const method of [
    "process.spawn",
    "resources.materialize",
    "resources.capture",
    "resources.references.create",
    "resources.references.relink",
    "tasks.start",
    "credentials.connections.authorizeProcess",
    "credentials.cookies.authorizeProcess",
  ])
    expect(restricted.availableMethods).not.toContain(method);
  expect(restricted.capabilities.resources).toMatchObject({
    maxChunkBytes: 32768,
    materialize: false,
    capture: false,
    externalReferences: true,
    createReferences: false,
    pickReferences: true,
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
    "resources.references.create",
    "resources.references.relink",
    "resources.references.pick",
    "credentials.connections.authorizeProcess",
  ])
    expect(value.availableMethods).toContain(method);
  expect(value.availableMethods).not.toContain("audio.transcribe");
  expect(value.availableMethods).not.toContain("automations.create");
  expect(value.availableMethods).toContain("media.assets.list");
  expect(value.availableMethods).not.toContain("media.tts");
  expect(value.capabilities.resources).toMatchObject({ materialize: true, capture: true });
  expect(value.capabilities.methodLimits["resources.references.pick"].timeoutMs).toBe(
    30 * 60 * 1000,
  );
  expect(value.capabilities.tasks).toEqual({ durable: true, cookieCredentials: false });
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

test("background Cookie metadata requires a configured service and all task permissions", () => {
  const permissions = ["resources", "process", "credentials.cookies"] as const;
  const enabled = desktopPanelCapabilities(permissions, { ...options, taskCookies: true });
  expect(enabled.availableMethods).toContain("credentials.cookies.listForTask");
  expect(enabled.capabilities.tasks).toMatchObject({ cookieCredentials: true });
  expect(enabled.capabilities.process).toMatchObject({ cookieCredentials: true });
  expect(enabled.capabilities.methodLimits["tasks.retry"].timeoutMs).toBe(30 * 60 * 1000);
  for (const permission of permissions) {
    const missing = desktopPanelCapabilities(
      permissions.filter((value) => value !== permission),
      { ...options, taskCookies: true },
    );
    expect(missing.availableMethods).not.toContain("credentials.cookies.listForTask");
    expect((missing.capabilities.process as any)?.cookieCredentials).not.toBe(true);
  }
  expect(desktopPanelCapabilities(permissions, options).availableMethods).not.toContain(
    "credentials.cookies.listForTask",
  );
  expect(
    (desktopPanelCapabilities(permissions, options).capabilities.process as any)?.cookieCredentials,
  ).not.toBe(true);
});

test("versioned storage is advertised only with storage permission and bounded limits", () => {
  const missing = desktopPanelCapabilities([], options);
  expect(missing.availableMethods).not.toContain("storage.getSnapshot");
  expect(missing.availableMethods).not.toContain("storage.compareAndSet");
  const allowed = desktopPanelCapabilities(["storage"], options);
  expect(allowed.availableMethods).toContain("storage.getSnapshot");
  expect(allowed.availableMethods).toContain("storage.compareAndSet");
  expect(allowed.capabilities.methodLimits["storage.compareAndSet"]).toEqual({
    maxParamsBytes: 256 * 1024 + 8192,
    maxResultBytes: 256 * 1024 + 8192,
  });
});

test("unique automation creation is advertised only by an implementing authorized host", () => {
  const legacy = { ...options, automations: true };
  expect(desktopPanelCapabilities(["automations.manage"], legacy).availableMethods).not.toContain(
    "automations.createUnique",
  );
  const modern = { ...legacy, automationUniqueCreate: true };
  expect(desktopPanelCapabilities(["automations.manage"], modern).availableMethods).toContain(
    "automations.createUnique",
  );
  expect(desktopPanelCapabilities([], modern).availableMethods).not.toContain(
    "automations.createUnique",
  );
  expect(
    desktopPanelCapabilities(["automations.manage"], { ...modern, automations: false })
      .availableMethods,
  ).not.toContain("automations.createUnique");
});
