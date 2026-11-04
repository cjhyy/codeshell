// A CLI room's permission mode is a spawn-time argument, so changing it means
// replacing the process. These tests pin the handoff contract: refuse while
// anything is in flight, wait for the old process to really exit, never let a
// pending handoff be crossed or resurrected, and roll metadata back on failure.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RoomBusyError,
  RoomManager,
  type RoomAgent,
  type RoomMeta,
  type RoomPermissionMode,
} from "./room-manager";
import type { ResidentAgentEvent } from "./resident-agent.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Poll the event loop until `condition` holds (bounded). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!condition()) throw new Error("condition not reached");
}

class FakeAgent implements RoomAgent {
  running = false;
  sent: string[] = [];
  /** Set to make stopAndWait wait for the test. */
  exit?: Promise<boolean>;
  busy?: boolean;
  startError?: Error;
  spawnError?: Error;
  constructor(
    readonly meta: RoomMeta,
    readonly emit: (event: ResidentAgentEvent) => void,
    private readonly log: string[],
  ) {}
  start(): void {
    if (this.startError) throw this.startError;
    this.running = true;
    this.log.push(`start:${this.meta.permissionMode}:${this.meta.claudeSessionId ?? ""}`);
  }
  send(text: string): boolean {
    if (!this.running) return false;
    this.sent.push(text);
    return true;
  }
  isRunning(): boolean {
    return this.running;
  }
  respondControl(requestId: string): void {
    this.log.push(`control:${requestId}`);
  }
  stop(): void {
    this.running = false;
    this.log.push(`stop:${this.meta.permissionMode}`);
  }
  async stopAndWait(): Promise<boolean> {
    this.log.push(`stopAndWait:${this.meta.permissionMode}`);
    const exited = this.exit ? await this.exit : true;
    if (exited) {
      this.running = false;
      this.log.push(`exited:${this.meta.permissionMode}`);
    }
    return exited;
  }
  whenStarted(): Promise<void> {
    return this.spawnError ? Promise.reject(this.spawnError) : Promise.resolve();
  }
}

class FakeCodexAgent extends FakeAgent {
  isBusy(): boolean {
    return this.busy === true;
  }
}

function makeManager(options: { codexBusy?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "room-mode-"));
  dirs.push(root);
  const project = realpathSync(join(root));
  mkdirSync(join(project, "other"));
  const log: string[] = [];
  const agents: FakeAgent[] = [];
  const ended: string[] = [];
  const stateChanges: string[] = [];
  let configure: (agent: FakeAgent) => void = () => undefined;
  const manager = new RoomManager({
    rootDir: join(root, "rooms"),
    processExitTimeoutMs: 50,
    onRoomStateChanged: (roomId) => stateChanges.push(roomId),
    createAgent: (meta, onEvent) => {
      const agent =
        meta.kind === "codex"
          ? new FakeCodexAgent(meta, onEvent, log)
          : new FakeAgent(meta, onEvent, log);
      if (meta.kind === "codex" && options.codexBusy) agent.busy = true;
      configure(agent);
      agents.push(agent);
      return agent;
    },
    onMessage: () => undefined,
    onRoomEnded: (roomId) => ended.push(roomId),
    resolveLinkedSession: (target) => target,
  });
  return {
    manager,
    project,
    log,
    agents,
    ended,
    stateChanges,
    latest: () => agents.at(-1)!,
    configureNext: (fn: (agent: FakeAgent) => void) => {
      configure = (agent) => {
        configure = () => undefined;
        fn(agent);
      };
    },
    open: (mode: RoomPermissionMode, kind: "claude-code" | "codex" = "claude-code") =>
      manager.openForSession("thread-1", project, mode, kind),
  };
}

describe("RoomManager permission-mode handoff", () => {
  test("an idle switch waits for the old process, then resumes the same session in the new mode", async () => {
    const f = makeManager();
    const first = await f.open("default");
    expect(first).toMatchObject({ status: "running", mode: "default" });
    const second = await f.open("acceptEdits");
    expect(second).toMatchObject({ roomId: first.roomId, status: "running", mode: "acceptEdits" });
    expect(f.log).toEqual([
      "start:default:thread-1",
      "stopAndWait:default",
      "exited:default",
      // Same external session id → the replacement resumes the conversation.
      "start:acceptEdits:thread-1",
    ]);
    expect(f.manager.getRoom(first.roomId)?.permissionMode).toBe("acceptEdits");
    expect(f.manager.liveMode(first.roomId)).toBe("acceptEdits");
    // Followers are not ended: the external session continues.
    expect(f.ended).toEqual([]);
  });

  test("reopening in the same mode is a no-op that never interrupts the live process", async () => {
    const f = makeManager();
    const first = await f.open("acceptEdits");
    f.manager.send(first.roomId, "working");
    const again = await f.open("acceptEdits");
    expect(again).toMatchObject({ roomId: first.roomId, status: "running", mode: "acceptEdits" });
    expect(f.log).toEqual(["start:acceptEdits:thread-1"]);
    expect(f.agents).toHaveLength(1);
  });

  test("an accepted turn blocks the switch until its turn_end, even when transcript-follow hides it", async () => {
    const f = makeManager();
    const { roomId } = await f.open("default");
    expect(f.manager.send(roomId, "one")).toBe(true);
    expect(f.manager.send(roomId, "two")).toBe(true);
    await expect(f.open("bypassPermissions")).rejects.toBeInstanceOf(RoomBusyError);
    expect(f.manager.getRoom(roomId)?.permissionMode).toBe("default");
    expect(f.log).toEqual(["start:default:thread-1"]);
    f.manager.beginTranscriptFollow(roomId);
    f.latest().emit({ type: "turn_end", reason: "success" });
    // One queued input is still unanswered.
    expect(f.manager.roomBusyReason(roomId)).toBe("turn");
    f.latest().emit({ type: "turn_end", reason: "success" });
    expect(f.manager.roomBusyReason(roomId)).toBeUndefined();
    await expect(f.open("bypassPermissions")).resolves.toMatchObject({ mode: "bypassPermissions" });
  });

  test("a Codex turn process that outlives turn_end keeps the room busy", async () => {
    const f = makeManager({ codexBusy: true });
    const { roomId } = await f.open("default", "codex");
    f.latest().emit({ type: "turn_end", reason: "completed" });
    expect(f.manager.roomBusyReason(roomId)).toBe("turn");
    await expect(f.open("bypassPermissions", "codex")).rejects.toThrow("仍有任务");
    f.latest().busy = false;
    await expect(f.open("bypassPermissions", "codex")).resolves.toMatchObject({
      mode: "bypassPermissions",
    });
  });

  for (const toolName of ["Bash", "AskUserQuestion"])
    test(`a pending ${toolName} card, including a decision not yet consumed, blocks the switch`, async () => {
      const f = makeManager();
      const { roomId } = await f.open("default");
      f.latest().emit({
        type: "approval_request",
        requestId: "req-1",
        toolName,
        input:
          toolName === "AskUserQuestion"
            ? { questions: [{ question: "Which?", options: [{ label: "A" }] }] }
            : { command: "ls" },
      });
      // The bridge may already have resolved; until respondApproval consumes it
      // the CLI is still waiting on this room's process.
      await expect(f.open("acceptEdits")).rejects.toThrow("待处理的审批");
      expect(f.manager.getRoom(roomId)?.permissionMode).toBe("default");
      expect(f.manager.respondApproval(roomId, "req-1", { behavior: "deny", message: "no" })).toBe(
        true,
      );
      await expect(f.open("acceptEdits")).resolves.toMatchObject({ mode: "acceptEdits" });
    });

  test("nothing can cross a handoff in progress, and close() cancels it for good", async () => {
    const f = makeManager();
    const { roomId } = await f.open("default");
    let release!: (exited: boolean) => void;
    f.latest().exit = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const switching = f.open("acceptEdits");
    await Promise.resolve();
    expect(f.manager.roomBusyReason(roomId)).toBe("switching");
    expect(() => f.manager.send(roomId, "late")).toThrow(RoomBusyError);
    expect(() => f.manager.open(roomId)).toThrow(RoomBusyError);
    expect(() =>
      f.manager.planSessionOpen({
        sessionId: "thread-1",
        cwd: f.project,
        kind: "claude-code",
        mode: "bypassPermissions",
      }),
    ).toThrow(RoomBusyError);
    await expect(
      f.manager.takeOverLinkedSession(roomId, "thread-1", f.project, "claude-code"),
    ).rejects.toThrow(RoomBusyError);
    f.manager.close(roomId);
    release(true);
    await expect(switching).rejects.toThrow("已被关闭");
    // No replacement was started after the explicit close, and the mode stayed.
    expect(f.log.filter((entry) => entry.startsWith("start:"))).toEqual(["start:default:thread-1"]);
    expect(f.manager.getRoom(roomId)?.permissionMode).toBe("default");
    expect(f.manager.isOpen(roomId)).toBe(false);
  });

  test("an old process that does not exit in time blocks the replacement (no double writer)", async () => {
    const f = makeManager();
    const { roomId } = await f.open("default");
    f.latest().exit = Promise.resolve(false);
    await expect(f.open("bypassPermissions")).rejects.toThrow("未能在时限内退出");
    expect(f.log.filter((entry) => entry.startsWith("start:"))).toHaveLength(1);
    expect(f.manager.getRoom(roomId)?.permissionMode).toBe("default");
  });

  test("close() during a handoff keeps the retired-process fence: no second CLI until the old one exits", async () => {
    const f = makeManager();
    const { roomId } = await f.open("default");
    let release!: (exited: boolean) => void;
    f.latest().exit = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const switching = f.open("acceptEdits");
    await until(() => f.log.includes("stopAndWait:default"));
    f.manager.close(roomId);
    // close() cancelled the handoff, but the old process may still be writing:
    // every start path is refused instead of starting beside it.
    expect(() => f.manager.open(roomId)).toThrow("旧进程");
    expect(() => f.manager.send(roomId, "late")).toThrow("旧进程");
    expect(f.manager.isOpen(roomId)).toBe(true);
    // An immediate reopen waits for proof of exit rather than double-starting.
    const reopen = f.open("default");
    await Promise.resolve();
    expect(f.agents).toHaveLength(1);

    release(true);
    await expect(switching).rejects.toThrow("已被关闭");
    await expect(reopen).resolves.toMatchObject({ roomId, status: "running", mode: "default" });
    expect(f.log).toEqual([
      "start:default:thread-1",
      "stopAndWait:default",
      "exited:default",
      // Only after the proven exit.
      "start:default:thread-1",
    ]);
    expect(f.manager.getRoom(roomId)?.permissionMode).toBe("default");
  });

  test("an ordinary close (Stop) fences the room until the stopped CLI really exits", async () => {
    const f = makeManager();
    const { roomId } = await f.open("default");
    let release!: (exited: boolean) => void;
    f.latest().exit = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    f.manager.close(roomId);
    expect(f.log).toEqual(["start:default:thread-1", "stop:default", "stopAndWait:default"]);
    // Still inside its SIGTERM grace: no start path may run a second writer.
    expect(() => f.manager.send(roomId, "next")).toThrow("旧进程");
    expect(() => f.manager.open(roomId)).toThrow("旧进程");
    expect(f.manager.isOpen(roomId)).toBe(true);
    // An immediate reopen waits for the proven exit instead of double-starting.
    const reopen = f.open("acceptEdits");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.agents).toHaveLength(1);
    // Close semantics are unchanged: followers ended once, nothing republished yet.
    expect(f.ended).toEqual([roomId]);
    expect(f.stateChanges).toEqual([]);

    release(true);
    await expect(reopen).resolves.toMatchObject({ roomId, status: "running", mode: "acceptEdits" });
    expect(f.log).toEqual([
      "start:default:thread-1",
      "stop:default",
      "stopAndWait:default",
      "exited:default",
      "start:acceptEdits:thread-1",
    ]);
    // Every view learned the stopped state once the exit was proven.
    expect(f.stateChanges).toEqual([roomId]);
  });

  test("a Stop whose exit times out stays fenced on every entry, then recovers after the exit", async () => {
    const f = makeManager();
    const { roomId } = await f.open("default");
    const old = f.latest();
    old.exit = Promise.resolve(false);
    f.manager.close(roomId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(f.open("default")).rejects.toThrow("旧进程");
    await expect(
      f.manager.takeOverLinkedSession(roomId, "thread-1", f.project, "claude-code"),
    ).rejects.toThrow("旧进程");
    expect(() => f.manager.open(roomId)).toThrow("旧进程");
    expect(() => f.manager.send(roomId, "x")).toThrow("旧进程");
    expect(f.agents).toHaveLength(1);
    expect(f.manager.isOpen(roomId)).toBe(true);
    expect(f.stateChanges).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    old.exit = Promise.resolve(true);
    await expect(f.open("default")).resolves.toMatchObject({ roomId, status: "running" });
    expect(f.log.filter((entry) => entry.startsWith("start:"))).toHaveLength(2);
    expect(f.log.indexOf("exited:default")).toBeLessThan(
      f.log.lastIndexOf("start:default:thread-1"),
    );
  });

  test("an exit timeout keeps the fence until the old process is proven gone, then a retry recovers", async () => {
    const f = makeManager();
    const { roomId } = await f.open("default");
    const old = f.latest();
    old.exit = Promise.resolve(false);
    await expect(f.open("acceptEdits")).rejects.toThrow("未能在时限内退出");
    // Still possibly alive: retries and implicit starts are refused, never doubled.
    await expect(f.open("acceptEdits")).rejects.toThrow("旧进程");
    await expect(f.open("default")).rejects.toThrow("旧进程");
    expect(() => f.manager.open(roomId)).toThrow("旧进程");
    expect(() => f.manager.send(roomId, "hi")).toThrow("旧进程");
    expect(f.agents).toHaveLength(1);
    // Not reported as stopped while it may still write; followers kept.
    expect(f.manager.isOpen(roomId)).toBe(true);
    expect(f.stateChanges).toEqual([]);
    expect(f.ended).toEqual([]);

    // Let the probes kicked by the refusals above settle (still "alive").
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.stateChanges).toEqual([]);
    // The process finally exits: a re-probe proves it and republishes the room.
    old.exit = Promise.resolve(true);
    expect(() => f.manager.send(roomId, "hi")).toThrow("旧进程");
    await until(() => f.stateChanges.length > 0);
    expect(f.stateChanges).toEqual([roomId]);
    expect(f.manager.isOpen(roomId)).toBe(false);

    const retried = await f.open("acceptEdits");
    expect(retried).toMatchObject({ roomId, status: "running", mode: "acceptEdits" });
    expect(f.log.filter((entry) => entry.startsWith("start:"))).toEqual([
      "start:default:thread-1",
      "start:acceptEdits:thread-1",
    ]);
    expect(f.log.indexOf("exited:default")).toBeLessThan(
      f.log.indexOf("start:acceptEdits:thread-1"),
    );
  });

  test("a synchronous start failure restores the previous mode and reports not running", async () => {
    const f = makeManager();
    const { roomId } = await f.open("default");
    f.configureNext((agent) => {
      agent.startError = new Error("spawn EACCES");
    });
    await expect(f.open("acceptEdits")).rejects.toThrow("spawn EACCES");
    expect(f.manager.getRoom(roomId)?.permissionMode).toBe("default");
    expect(f.manager.isOpen(roomId)).toBe(false);
    // Every view (not only the requester) learns the room stopped; transcript
    // followers of the still-existing external session are kept.
    expect(f.stateChanges).toEqual([roomId]);
    expect(f.ended).toEqual([]);
  });

  test("an asynchronous spawn error restores the previous mode instead of claiming running", async () => {
    const f = makeManager();
    const { roomId } = await f.open("default");
    const spawnError = new Error("spawn claude ENOENT");
    f.configureNext((agent) => {
      agent.spawnError = spawnError;
    });
    const error = await f.open("acceptEdits").catch((e: unknown) => e);
    expect((error as Error).message).toContain("CLI 进程启动失败");
    expect((error as Error).cause).toBe(spawnError);
    expect(f.manager.getRoom(roomId)?.permissionMode).toBe("default");
    expect(f.manager.isOpen(roomId)).toBe(false);
    expect(f.stateChanges).toEqual([roomId]);
    expect(f.ended).toEqual([]);
  });

  test("a failed first start is published to every view", async () => {
    const f = makeManager();
    f.configureNext((agent) => {
      agent.spawnError = new Error("spawn claude ENOENT");
    });
    await expect(f.open("default")).rejects.toThrow("CLI 进程启动失败");
    const room = f.manager.findSessionRoom("thread-1", "claude-code")!;
    expect(f.stateChanges).toEqual([room.id]);
    expect(f.manager.isOpen(room.id)).toBe(false);
  });

  test("an authorization failure before the stop changes nothing", async () => {
    const f = makeManager();
    const { roomId } = await f.open("default");
    const plan = f.manager.planSessionOpen({
      sessionId: "thread-1",
      cwd: f.project,
      kind: "claude-code",
      mode: "acceptEdits",
    });
    await expect(
      f.manager.applySessionOpen(plan, {
        authorize: () => {
          throw new Error("requester gone");
        },
      }),
    ).rejects.toThrow("requester gone");
    expect(f.log).toEqual(["start:default:thread-1"]);
    expect(f.manager.liveMode(roomId)).toBe("default");
  });

  test("a stale plan cannot be applied after the room changed", async () => {
    const f = makeManager();
    await f.open("default");
    const plan = f.manager.planSessionOpen({
      sessionId: "thread-1",
      cwd: f.project,
      kind: "claude-code",
      mode: "acceptEdits",
    });
    await f.open("bypassPermissions");
    await expect(f.manager.applySessionOpen(plan)).rejects.toThrow("状态已变化");
  });

  test("a session room is reused only in its own directory and kind; observe-only stays observing", async () => {
    const f = makeManager();
    const claude = await f.open("default");
    await expect(
      f.manager.openForSession("thread-1", join(f.project, "other"), "default", "claude-code"),
    ).rejects.toThrow("另一个目录");
    const codex = await f.open("default", "codex");
    expect(codex.roomId).not.toBe(claude.roomId);

    const linked = f.manager.openLinkedSession("thread-observed", f.project, "claude-code");
    const result = await f.manager.openForSession(
      "thread-observed",
      f.project,
      "bypassPermissions",
      "claude-code",
    );
    expect(result).toMatchObject({ roomId: linked.roomId, status: "observing" });
    expect(f.manager.getRoom(linked.roomId)?.permissionMode).toBe("default");
  });

  test("the Host start hook guards every implicit start", async () => {
    const root = mkdtempSync(join(tmpdir(), "room-start-hook-"));
    dirs.push(root);
    const starts: string[] = [];
    const manager = new RoomManager({
      rootDir: join(root, "rooms"),
      authorizeStart: (meta) => {
        if (meta.permissionMode === "bypassPermissions") throw new Error("needs Host grant");
      },
      createAgent: (meta) => ({
        start: () => void starts.push(meta.permissionMode),
        send: () => true,
        isRunning: () => true,
        stop: () => undefined,
      }),
      onMessage: () => undefined,
    });
    const room = manager.createRoom({
      cwd: root,
      permissionMode: "bypassPermissions",
      claudeSessionId: "stored",
    });
    expect(() => manager.open(room.id)).toThrow("needs Host grant");
    expect(() => manager.send(room.id, "hi")).toThrow("needs Host grant");
    await expect(
      manager.openForSession("stored", root, "bypassPermissions", "claude-code"),
    ).rejects.toThrow("needs Host grant");
    expect(starts).toEqual([]);
  });
});
