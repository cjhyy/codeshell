import { expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingMobileApprovals } from "@cjhyy/code-shell-server/mobile-remote";
import type { MobileRemoteOrchestratorDeps } from "../mobile-remote-orchestrator.js";
// The real storage/project/orchestrator execute in a private child process.
// Only the unused Electron worker import is replaced; these tests never spawn a worker.
globalThis.fetch = (async () => {
  throw new Error("History authority fixture refuses network access");
}) as unknown as typeof fetch;
mock.module("../agent-bridge.js", () => ({
  resolveNoRepoCwd() {
    throw new Error("This fixture requires a registered project");
  },
}));
const { SessionManager } = await import("@cjhyy/code-shell-core");
const { MobileRemoteOrchestrator } = await import("../mobile-remote-orchestrator.js");
const { getProjectStore } = await import("../project-store.js");

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mobile-history-owner-")));
  const store = getProjectStore();
  const project = await store.createFromPath(directory);
  const manager = new SessionManager();
  const sessions = [
    manager.create(directory, "synthetic", "openai"),
    manager.create(directory, "synthetic", "openai"),
  ];
  for (const session of sessions)
    manager.migrateSessionMainRoot(
      session.state.sessionId,
      { projectId: project.id, mainRootId: project.roots[0]!.id },
      directory,
    );
  let authenticated = true;
  let owner: number | undefined;
  let ownerRevision = 0;
  const pendingApprovals = new PendingMobileApprovals();
  const bridge = {
    getLastRunContext: () => ({}),
    panelOwnerWebContentsId: () => owner,
    sessionPanelOwnerRevision: () => ownerRevision,
    getSnapshot: () => ({ events: [], nextSeq: 1, topLevelRunning: false }),
  };
  const remote = {
    hasAuthenticatedViewer: (_viewer: string, device: string) =>
      authenticated && device === "phone",
    sendToViewer() {},
    sendToDevice() {},
    sendRawToDevice() {},
    broadcast() {},
    broadcastRaw() {},
  };
  const orchestrator = new MobileRemoteOrchestrator({
    remote,
    pendingApprovals,
    getBridge: () => bridge,
    broadcastToWindows() {},
  } as unknown as MobileRemoteOrchestratorDeps);
  const select = (viewerId: string, sessionId: string) =>
    orchestrator.handleMobileClientEvent({
      type: "session.select",
      viewerId,
      deviceId: "phone",
      sessionId,
    });
  return {
    orchestrator,
    project,
    manager,
    sessions,
    pendingApprovals,
    select,
    setOwner(value: number | undefined) {
      ownerRevision++;
      owner = value;
    },
    revoke() {
      authenticated = false;
    },
    async cleanup() {
      await store.remove(project.id);
      for (const session of sessions)
        rmSync(join(manager.getStorageDir(), session.state.sessionId), {
          recursive: true,
          force: true,
        });
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("the selected socket, not a sibling tab's device selection, owns an inactive recovery", async () => {
  const f = await fixture();
  try {
    const a = f.sessions[0]!.state.sessionId;
    const b = f.sessions[1]!.state.sessionId;
    await f.select("tab-a", a);
    await f.select("tab-b", b);
    const auth = await f.orchestrator.authorizeOutputHistoryRecovery(a, {
      kind: "mobile",
      viewerId: "tab-a",
      deviceId: "phone",
    });
    expect(auth.projectId).toBe(f.project.id);
    expect(auth.ownerWebContentsId).toBeUndefined();
    expect(() => auth.assertCurrent()).not.toThrow();
    await expect(
      f.orchestrator.authorizeOutputHistoryRecovery(a, {
        kind: "mobile",
        viewerId: "tab-b",
        deviceId: "phone",
      }),
    ).rejects.toThrow();
    await f.select("tab-a", b);
    expect(() => auth.assertCurrent()).toThrow();
    expect(
      f.sessions
        .flatMap((session) => session.transcript.getEvents())
        .filter((event) => event.type === "message"),
    ).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("recovery authority rechecks live authentication and the actual Session owner", async () => {
  const f = await fixture();
  try {
    const id = f.sessions[0]!.state.sessionId;
    await f.select("tab-a", id);
    const auth = await f.orchestrator.authorizeOutputHistoryRecovery(id, {
      kind: "mobile",
      viewerId: "tab-a",
      deviceId: "phone",
    });
    f.setOwner(77);
    expect(() => auth.assertCurrent()).toThrow();
    f.setOwner(undefined);
    expect(() => auth.assertCurrent()).toThrow();
    f.revoke();
    expect(() => auth.assertCurrent()).toThrow();
    await expect(
      f.orchestrator.authorizeOutputHistoryRecovery(id, {
        kind: "mobile",
        viewerId: "tab-a",
        deviceId: "phone",
      }),
    ).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("retirement clears all old tabs and only that Session's pending approvals", async () => {
  const f = await fixture();
  try {
    const id = f.sessions[0]!.state.sessionId;
    const other = f.sessions[1]!.state.sessionId;
    await f.select("tab-a", id);
    await f.select("tab-b", id);
    const a = await f.orchestrator.authorizeOutputHistoryRecovery(id, {
      kind: "mobile",
      viewerId: "tab-a",
      deviceId: "phone",
    });
    const b = await f.orchestrator.authorizeOutputHistoryRecovery(id, {
      kind: "mobile",
      viewerId: "tab-b",
      deviceId: "phone",
    });
    for (const [sessionId, requestId] of [
      [id, "old"],
      [other, "other"],
    ])
      f.pendingApprovals.observeOutboundLine(
        JSON.stringify({ method: "agent/approvalRequest", params: { sessionId, requestId } }),
      );
    f.orchestrator.retireOutputHistorySession(id);
    expect(() => a.assertCurrent()).toThrow();
    expect(() => b.assertCurrent()).toThrow();
    expect(f.pendingApprovals.replayLines(id)).toHaveLength(0);
    expect(f.pendingApprovals.replayLines(other)).toHaveLength(1);
    await f.select("tab-a", id);
    const fresh = await f.orchestrator.authorizeOutputHistoryRecovery(id, {
      kind: "mobile",
      viewerId: "tab-a",
      deviceId: "phone",
    });
    expect(() => fresh.assertCurrent()).not.toThrow();
    expect(fresh.key).not.toBe(a.key);
  } finally {
    await f.cleanup();
  }
});
