import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { TaskInboxBackgroundEntry } from "../task-inbox/task-inbox-sources.js";
import { registerLinkedSessionObservationIpc } from "./linked-session-observation-ipc.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sender(id: number) {
  let destroyed = false;
  const cleanup: Array<() => void> = [];
  const content = {
    id,
    mainFrame: {},
    isDestroyed: () => destroyed,
    once: (_name: string, listener: () => void) => cleanup.push(listener),
  } as unknown as WebContents;
  return {
    event: { sender: content, senderFrame: content.mainFrame } as IpcMainInvokeEvent,
    window: { webContents: content, isDestroyed: () => destroyed },
    destroy() {
      destroyed = true;
      cleanup.splice(0).forEach((listener) => listener());
    },
  };
}

async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "linked-observation-ipc-")));
  roots.push(cwd);
  const source = { jobId: "job-1", sourceSessionId: "parent-1" };
  const job: TaskInboxBackgroundEntry = {
    kind: "job",
    jobKind: "drive-agent",
    jobId: source.jobId,
    sourceSession: { sessionId: source.sourceSessionId, shortId: "parent", current: true },
    description: "Delegated work",
    status: "running",
    startedAt: 1,
    cwd,
    cli: "codex",
    externalSessionId: "thread-1",
  };
  const owner = sender(10);
  const windows = [owner.window];
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => any>();
  const calls = {
    open: [] as unknown[][],
    takeover: [] as unknown[][],
    subscribe: [] as unknown[],
    unsubscribe: [] as unknown[][],
    unsubscribeSender: [] as string[],
    end: [] as string[],
    close: [] as string[],
  };
  let registered = false;
  let list = async (): Promise<TaskInboxBackgroundEntry[]> => [job];
  let requirePath = async (value: unknown): Promise<string> => {
    if (!registered || value !== cwd) throw new Error("path is not registered");
    return cwd;
  };
  registerLinkedSessionObservationIpc({
    ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler) },
    windows,
    roomManager: {
      openLinkedSession: (...args) => {
        calls.open.push(args);
        return { roomId: "room-1", cwd, status: "observing", mode: "default" };
      },
      takeOverLinkedSession: (...args) => {
        calls.takeover.push(args);
        return { roomId: "room-1", cwd, status: "running", mode: "default" };
      },
      close: (roomId) => void calls.close.push(roomId),
    },
    listBackgroundWork: () => list(),
    requirePath: (value) => requirePath(value),
    subscriptions: {
      subscribe: (request) => {
        calls.subscribe.push(request);
        return { active: true, messages: [], hasMore: false, totalCount: 0, roomCursor: 7 };
      },
      unsubscribe: (...args) => void calls.unsubscribe.push(args),
      unsubscribeSubscriber: (id) => void calls.unsubscribeSender.push(id),
      endRoom: (roomId) => void calls.end.push(roomId),
    },
    roomMatchesTranscript: (roomId, path, sessionId, kind) =>
      roomId === "room-1" && path === cwd && sessionId === "thread-1" && kind === "codex",
    pendingApprovals: () => [{ requestId: "approval-1" }],
  });
  const invoke = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) =>
    handlers.get(channel)!(event, ...args);
  return {
    cwd,
    source,
    job,
    owner,
    windows,
    calls,
    invoke,
    setRegistered: (value: boolean) => (registered = value),
    setList: (value: typeof list) => (list = value),
    setRequirePath: (value: typeof requirePath) => (requirePath = value),
    open: (event = owner.event) =>
      invoke("ccRoom:openLinkedSession", event, "thread-1", cwd, "codex", source),
    subscribe: (event = owner.event) =>
      invoke("ccRoom:subscribeTranscript", event, "room-1", cwd, "thread-1", "codex", 20),
  };
}

describe("linked session observation IPC registrar", () => {
  test("preserves project-authorized open, transcript snapshots and explicit takeover", async () => {
    const f = await fixture();
    f.setRegistered(true);
    f.setList(async () => {
      throw new Error("project sessions do not need a delegation lookup");
    });
    await f.invoke("ccRoom:openLinkedSession", f.owner.event, "thread-1", f.cwd, "codex");
    expect(await f.subscribe()).toMatchObject({
      roomCursor: 7,
      approvals: [{ requestId: "approval-1" }],
    });
    expect(f.calls.subscribe).toEqual([
      {
        subscriberId: "desktop:10",
        roomId: "room-1",
        cwd: f.cwd,
        sessionId: "thread-1",
        kind: "codex",
        limit: 20,
      },
    ]);
    await f.invoke(
      "ccRoom:takeOverLinkedSession",
      f.owner.event,
      "room-1",
      "thread-1",
      f.cwd,
      "codex",
    );
    expect(f.calls.takeover).toHaveLength(1);
    await f.invoke("ccRoom:unsubscribeTranscript", f.owner.event, "room-1");
    expect(f.calls.unsubscribe).toEqual([["desktop:10", "room-1"]]);
    f.owner.destroy();
    expect(f.calls.unsubscribeSender).toEqual(["desktop:10"]);
  });

  test("allows exact delegated observations but keeps takeover behind the project gate", async () => {
    const f = await fixture();
    await expect(f.open()).resolves.toMatchObject({ status: "observing" });
    await f.subscribe();
    await expect(
      f.invoke("ccRoom:takeOverLinkedSession", f.owner.event, "room-1", "thread-1", f.cwd, "codex"),
    ).rejects.toThrow("not registered");
    expect(f.calls.takeover).toEqual([]);
    await expect(
      f.invoke(
        "ccRoom:subscribeTranscript",
        f.owner.event,
        "room-other",
        f.cwd,
        "thread-1",
        "codex",
        20,
      ),
    ).rejects.toThrow();
    expect(f.calls.subscribe).toHaveLength(1);
  });

  test("requires an application main frame for both fallback open and subscription", async () => {
    const f = await fixture();
    const outsider = sender(11);
    const subframe = { ...f.owner.event, senderFrame: {} } as IpcMainInvokeEvent;
    await expect(f.open(outsider.event)).rejects.toThrow("application window");
    await expect(f.open(subframe)).rejects.toThrow("application window");
    expect(f.calls.open).toEqual([]);
    await f.open();
    await expect(f.subscribe(outsider.event)).rejects.toThrow("application window");
    await expect(f.subscribe(subframe)).rejects.toThrow("application window");
    f.windows.push(outsider.window);
    await expect(f.subscribe(outsider.event)).rejects.toThrow("no matching observation");
    expect(f.calls.subscribe).toEqual([]);
  });

  test("room closure revokes observations and ends CC transcript followers", async () => {
    const f = await fixture();
    for (const channel of ["rooms:close", "ccRoom:closeSession"]) {
      await f.open();
      await f.subscribe();
      await f.invoke(channel, f.owner.event, "room-1");
      await expect(f.subscribe()).rejects.toThrow("no matching observation");
    }
    expect(f.calls.close).toEqual(["room-1", "room-1"]);
    expect(f.calls.end).toEqual(["room-1"]);
  });

  test("a delayed open cannot retain a grant after its window was destroyed", async () => {
    const f = await fixture();
    let release!: (jobs: TaskInboxBackgroundEntry[]) => void;
    let started!: () => void;
    const reachedList = new Promise<void>((resolve) => (started = resolve));
    f.setList(() => {
      started();
      return new Promise((resolve) => (release = resolve));
    });
    const opening = f.open();
    await reachedList;
    f.owner.destroy();
    release([f.job]);
    await expect(opening).rejects.toThrow("window was closed");
    expect(f.calls.unsubscribeSender).toEqual(["desktop:10"]);
    const replacement = sender(10);
    f.windows.push(replacement.window);
    await expect(f.subscribe(replacement.event)).rejects.toThrow("no matching observation");
    expect(f.calls.subscribe).toEqual([]);
  });

  test("a subscription awaiting authorization cannot restart a destroyed window's watcher", async () => {
    const f = await fixture();
    await f.open();
    await f.subscribe();
    let release!: (cwd: string) => void;
    f.setRequirePath(() => new Promise((resolve) => (release = resolve)));
    const subscribing = f.subscribe();
    f.owner.destroy();
    release(f.cwd);
    await expect(subscribing).rejects.toThrow("window was closed");
    expect(f.calls.subscribe).toHaveLength(1);
    expect(f.calls.unsubscribeSender).toEqual(["desktop:10"]);
  });
});
