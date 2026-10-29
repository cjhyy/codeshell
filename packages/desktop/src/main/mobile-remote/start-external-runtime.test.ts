import { expect, test } from "bun:test";
import type { BrowserWindow } from "electron";
import type {
  ExternalRuntimeService,
  ExternalRuntimeStartRequest,
} from "../external-runtime-service.js";
import { startMobileExternalRuntime } from "./start-external-runtime.js";

function harness() {
  let owner: number | undefined;
  let running = false,
    authorized = true,
    closed = false;
  const starts: ExternalRuntimeStartRequest[] = [];
  const windows = [11, 22].map(
    (id) => ({ webContents: { id }, isDestroyed: () => closed }) as BrowserWindow,
  );
  let duringHistory = () => {};
  const bridge = { panelOwnerWebContentsId: () => owner, isSessionRunning: () => running };
  const service = {
    get: () => undefined,
    ensureContinuation: async (request: ExternalRuntimeStartRequest) => {
      request.assertStartAuthority?.();
      starts.push(request);
      owner = request.ownerWindow?.webContents.id;
      return {};
    },
  } as unknown as ExternalRuntimeService;
  const request = {
    sessionId: "mobile-new",
    cwd: "/project",
    modelKey: "codex/test-model",
    assertCurrent: () => {
      if (!authorized) throw new Error("revoked");
    },
  };
  const start = (ownerId?: number) =>
    startMobileExternalRuntime(
      {
        service: () => service,
        bridge: () => bridge,
        windows: () => windows,
        history: async () => {
          duringHistory();
          return [
            {
              id: "message-1",
              type: "message",
              data: { role: "user", content: "continue my earlier work" },
            },
          ] as never;
        },
      },
      { ...request, owner: ownerId },
    );
  return {
    start,
    starts,
    setOwner: (id: number) => {
      owner = id;
    },
    setRunning: () => {
      running = true;
    },
    revokeDuringHistory: () => {
      duringHistory = () => {
        authorized = false;
      };
    },
    closeDuringHistory: () => {
      duringHistory = () => {
        closed = true;
      };
    },
    replaceOwnerDuringHistory: () => {
      duringHistory = () => {
        owner = 22;
      };
    },
  };
}

test("mobile runtime startup pins a Main-selected Desktop owner and passes canonical history", async () => {
  const f = harness();
  await f.start();
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]?.kind).toBe("codex");
  expect(f.starts[0]?.model).toBe("test-model");
  expect(f.starts[0]?.ownerWindow?.webContents.id).toBe(11);
  expect(f.starts[0]?.permissionMode).toBeUndefined();
  expect(f.starts[0]?.initialContext).toContain("continue my earlier work");
});

test("an existing owner is preserved instead of borrowing the first Desktop window", async () => {
  const f = harness();
  f.setOwner(22);
  await f.start(22);
  expect(f.starts[0]?.ownerWindow?.webContents.id).toBe(22);
});

for (const scenario of [
  "revokeDuringHistory",
  "closeDuringHistory",
  "replaceOwnerDuringHistory",
  "setRunning",
] as const)
  test(`mobile startup refuses ${scenario} before calling the external service`, async () => {
    const f = harness();
    f[scenario]();
    await expect(f.start()).rejects.toThrow();
    expect(f.starts).toHaveLength(0);
  });

test("a stale selection cannot claim a different existing owner", async () => {
  const f = harness();
  f.setOwner(22);
  await expect(f.start(11)).rejects.toThrow();
  expect(f.starts).toHaveLength(0);
});
