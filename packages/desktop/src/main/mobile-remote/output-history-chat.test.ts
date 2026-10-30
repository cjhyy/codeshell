import { expect, test } from "bun:test";
import type { AgentBridge } from "../agent-bridge.js";
import { acquireOutputHistoryRecovery } from "../session-output-history-lease.js";
import { handleClientEvent, type OrchestratorCtx } from "./handle-client-event.js";
import { captureMobileHistoryWrite, submitMobileHistoryWrite } from "./output-history-chat.js";

test.each([false, true])(
  "a checkpoint retires an in-flight %s producer before workspace admission",
  async (external) => {
    const sessionId = `history-write-${external ? "external" : "native"}`;
    let resume!: (path: string) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const workspace = new Promise<string>((resolve) => {
      resume = resolve;
    });
    let physical = 0;
    const replies: unknown[] = [];
    const permissionBroadcasts: Parameters<OrchestratorCtx["broadcastDesktopPermissionMode"]>[0][] =
      [];
    const bridge = {
      getLastRunContext: () => ({}),
      subscribeOutbound: () => () => {},
      injectWorkerMessage: () => {
        physical++;
      },
    } as unknown as AgentBridge;
    const ctx = {
      remote: {
        sendToDevice: (_device: string, message: unknown) => replies.push(message),
        sendToViewer: (_viewer: string, message: unknown) => replies.push(message),
      },
      uploads: {
        claim: () => {
          throw new Error("unexpected upload");
        },
        release: async () => {},
        finalize: async () => {},
      },
      getBridge: () => bridge,
      mobileSessionCwds: new Map(),
      mobilePermissionModes: new Map(),
      deviceState: () => ({ selectedSessionId: sessionId, selectedCwd: "/fixture" }),
      ensureMobileSessionId: () => sessionId,
      effectiveMobileRunCwd: () => "/fixture",
      resolveSessionWorkspaceRoot: async () => {
        entered();
        return workspace;
      },
      externalCommands: external
        ? {
            observe() {},
            isExternal: () => true,
            prepare: async () => {
              entered();
              await workspace;
              return {
                cwd: "/fixture",
                submit: async () => {
                  physical++;
                  return { ok: true };
                },
              };
            },
          }
        : undefined,
      broadcastMobileSession() {},
      broadcastDesktopPermissionMode: (mode) => permissionBroadcasts.push(mode),
      settleMobileUploadClaims: async () => {},
    } satisfies Pick<OrchestratorCtx, "broadcastDesktopPermissionMode"> &
      Record<string, unknown> as unknown as OrchestratorCtx;
    const pending = handleClientEvent(ctx, {
      type: "chat.send",
      sessionId,
      deviceId: "phone",
      viewerId: "tab",
      text: "held message",
      clientMessageId: "old-intent",
    });
    await ready;
    const release = acquireOutputHistoryRecovery(sessionId);
    release();
    resume("/fixture");
    await pending;
    expect(physical).toBe(0);
    expect(permissionBroadcasts).toEqual([{ sessionId, mode: "default" }]);
    expect(replies).toEqual([
      expect.objectContaining({ type: "error", clientMessageId: "old-intent" }),
    ]);
    expect(replies).not.toContainEqual(expect.objectContaining({ type: "chat.uncertain" }));
  },
);

test("held writes fail before transport, while fresh and unrelated intents remain usable", async () => {
  const sessionId = "history-write-fresh";
  const old = captureMobileHistoryWrite(sessionId);
  const unrelated = captureMobileHistoryWrite("history-write-unrelated");
  const release = acquireOutputHistoryRecovery(sessionId);
  expect(() => captureMobileHistoryWrite(sessionId)).toThrow();
  release();
  let sent = 0;
  const submit = async () => {
    sent++;
    return { ok: true as const };
  };
  const bridge = {
    subscribeOutbound: () => () => {},
    injectWorkerMessage: () => {
      throw new Error("unexpected native input");
    },
  };
  const request = { id: "explicit-new-intent", params: {} };
  expect(
    await submitMobileHistoryWrite(old, bridge, { origin: "mobile" }, request, submit),
  ).toMatchObject({ ok: false });
  expect(sent).toBe(0);
  expect(
    await submitMobileHistoryWrite(
      captureMobileHistoryWrite(sessionId),
      bridge,
      { origin: "mobile" },
      request,
      submit,
    ),
  ).toEqual({ ok: true });
  expect(
    await submitMobileHistoryWrite(unrelated, bridge, { origin: "mobile" }, request, submit),
  ).toEqual({ ok: true });
  expect(sent).toBe(2);
});
