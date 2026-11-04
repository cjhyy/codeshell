import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RoomManager,
  type LinkedSessionTarget,
  type RoomMeta,
} from "@cjhyy/code-shell-server/mobile-remote";
import {
  ROOM_MODE_APPROVAL_PURPOSE,
  ROOM_MODE_APPROVAL_TOOL,
  RoomModeAuthority,
  RoomModeAuthorizationError,
  roomModeApprovalPayload,
  trustedClaudeWorkspacesFromUserSettings,
  type RoomModeApproval,
  type RoomModeRequester,
} from "./room-mode-authority.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Decision = { approved: boolean; reason?: string };

/** Poll the event loop until `condition` holds (bounded). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!condition()) throw new Error("condition not reached");
}

function fixture(
  options: {
    trusted?: unknown[];
    decide?: (approval: RoomModeApproval, signal: AbortSignal) => Promise<Decision>;
    approvalTimeoutMs?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "room-mode-authority-"));
  roots.push(root);
  const project = realpathSync(mkdtempSync(join(root, "project-")));
  const starts: Array<{ roomId: string; mode: string; cwd: string }> = [];
  const approvals: RoomModeApproval[] = [];
  const stateChanges: string[] = [];
  let projectAuthorized = true;
  let trusted: unknown[] = options.trusted ?? [];
  let decide =
    options.decide ?? (async (): Promise<Decision> => ({ approved: true }));
  /** The CLI's on-disk session records (what the Host resolver would find). */
  let sessions: LinkedSessionTarget[] = ["thread-1", "thread-codex", "thread-stored"].flatMap(
    (externalSessionId) =>
      (["claude-code", "codex"] as const).map((kind) => ({ externalSessionId, kind, cwd: project })),
  );
  let resolveSession = (target: Readonly<LinkedSessionTarget>): LinkedSessionTarget | null =>
    sessions.find(
      (record) =>
        record.externalSessionId === target.externalSessionId &&
        record.kind === target.kind &&
        resolve(record.cwd) === resolve(target.cwd),
    ) ?? null;
  /** Awaited inside every project-path check, to pause one request there. */
  let pathGate: (() => Promise<void>) | undefined;
  /** While set, a stopped process exits only when the test resolves this. */
  let exitGate: { promise: Promise<boolean>; resolve: (exited: boolean) => void } | undefined;
  let exitWaiting = false;
  const manager: RoomManager = new RoomManager({
    rootDir: join(root, "rooms"),
    authorizeStart: (meta) => authority.authorizeStart(meta),
    onRoomClosed: (roomId) => authority.revoke(roomId),
    onRoomStateChanged: (roomId) => stateChanges.push(roomId),
    createAgent: (meta: RoomMeta) => {
      let running = false;
      return {
        start: () => {
          running = true;
          starts.push({ roomId: meta.id, mode: meta.permissionMode, cwd: meta.cwd });
        },
        send: () => running,
        isRunning: () => running,
        stop: () => {
          running = false;
        },
        stopAndWait: async () => {
          exitWaiting = true;
          const exited = exitGate ? await exitGate.promise : true;
          exitWaiting = false;
          if (exited) running = false;
          return exited;
        },
      };
    },
    onMessage: () => undefined,
  });
  const authority: RoomModeAuthority = new RoomModeAuthority({
    roomManager: manager,
    requireProjectPath: async (cwd) => {
      await pathGate?.();
      if (!projectAuthorized) throw new Error("project path is not registered with CodeShell");
      return realpathSync(cwd);
    },
    resolveSession: (target) => resolveSession(target),
    trustedClaudeWorkspaces: async () => trusted,
    requestApproval: (approval, _requester, signal) => {
      approvals.push(approval);
      return decide(approval, signal);
    },
    ...(options.approvalTimeoutMs ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
  });
  let online = true;
  const requester = (key = "mobile:tab-1", openRequestId?: string): RoomModeRequester => ({
    key,
    channel: "mobile",
    ...(openRequestId ? { openRequestId } : {}),
    assertCurrent: () => {
      if (!online) throw new Error("gone");
    },
  });
  return {
    manager,
    authority,
    project,
    starts,
    approvals,
    stateChanges,
    requester,
    setSessions: (value: LinkedSessionTarget[]) => (sessions = value),
    setResolver: (value: typeof resolveSession) => (resolveSession = value),
    setPathGate: (value: typeof pathGate) => (pathGate = value),
    holdExit: () => {
      let release!: (exited: boolean) => void;
      const promise = new Promise<boolean>((r) => (release = r));
      exitGate = { promise, resolve: release };
    },
    exitWaiting: () => exitWaiting,
    releaseExit: (exited: boolean) => {
      const gate = exitGate;
      exitGate = undefined;
      gate?.resolve(exited);
    },
    setOnline: (value: boolean) => (online = value),
    setProjectAuthorized: (value: boolean) => (projectAuthorized = value),
    setTrusted: (value: unknown[]) => (trusted = value),
    setDecide: (value: typeof decide) => (decide = value),
    open: (
      mode: "default" | "acceptEdits" | "bypassPermissions",
      kind: "claude-code" | "codex" = "claude-code",
      who = requester(),
    ) =>
      authority.openSession({ sessionId: "thread-1", cwd: project, kind, mode, requester: who }),
  };
}

describe("RoomModeAuthority", () => {
  for (const kind of ["claude-code", "codex"] as const)
    for (const mode of ["default", "acceptEdits"] as const)
      test(`${kind} ${mode} is applied as chosen without a Host card`, async () => {
        const f = fixture();
        const result = await f.open(mode, kind);
        expect(result).toMatchObject({ status: "running", mode, requestedMode: mode });
        expect(f.approvals).toEqual([]);
        expect(f.starts).toEqual([{ roomId: result.roomId, mode, cwd: f.project }]);
      });

  for (const kind of ["claude-code", "codex"] as const)
    test(`${kind} bypass outside the allowlist needs one bound Host approval, then really runs in bypass`, async () => {
      const f = fixture();
      const result = await f.open("bypassPermissions", kind, f.requester("mobile:tab-1", "open-7"));
      expect(result).toMatchObject({
        status: "running",
        mode: "bypassPermissions",
        approved: true,
      });
      expect(f.approvals).toHaveLength(1);
      const approval = f.approvals[0]!;
      expect(approval).toMatchObject({
        roomId: result.roomId,
        sessionId: "thread-1",
        kind,
        cwd: f.project,
        toMode: "bypassPermissions",
        requesterKey: "mobile:tab-1",
        revision: 0,
        openRequestId: "open-7",
      });
      expect(approval.requestId).toMatch(/^room-mode-[0-9a-f-]{36}$/);
      expect(f.starts).toEqual([
        { roomId: result.roomId, mode: "bypassPermissions", cwd: f.project },
      ]);
      // The card is a Host purpose, distinguishable from any CLI tool approval.
      const payload = roomModeApprovalPayload(approval);
      expect(payload).toMatchObject({
        toolName: ROOM_MODE_APPROVAL_TOOL,
        purpose: ROOM_MODE_APPROVAL_PURPOSE,
        modeChange: { cwd: f.project, kind, toMode: "bypassPermissions", openRequestId: "open-7" },
      });
      if (kind === "codex") expect(payload.description).toContain("关闭沙箱");
    });

  for (const [name, decide, code] of [
    ["denied", async (): Promise<Decision> => ({ approved: false, reason: "已拒绝" }), "denied"],
    [
      "undeliverable",
      async (): Promise<Decision> => {
        throw new Error("approval prompt could not be delivered");
      },
      "denied",
    ],
    ["timed out", () => new Promise<Decision>(() => undefined), "timeout"],
  ] as const)
    test(`a ${name} bypass approval keeps the previous state and says why`, async () => {
      const f = fixture({ decide, approvalTimeoutMs: 20 });
      const running = await f.open("default");
      expect(f.starts).toHaveLength(1);
      const error = await f.open("bypassPermissions").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RoomModeAuthorizationError);
      expect((error as RoomModeAuthorizationError).code).toBe(code);
      expect((error as Error).message).toContain("权限模式未更改");
      // The default process kept running and its mode was not rewritten.
      expect(f.starts).toHaveLength(1);
      expect(f.manager.getRoom(running.roomId)?.permissionMode).toBe("default");
      expect(f.manager.isOpen(running.roomId)).toBe(true);
    });

  test("a denied first open creates no room and starts nothing (no default fallback)", async () => {
    const f = fixture({ decide: async () => ({ approved: false }) });
    await expect(f.open("bypassPermissions")).rejects.toThrow("未获批准");
    expect(f.starts).toEqual([]);
    expect(f.manager.findSessionRoom("thread-1", "claude-code")).toBeUndefined();
  });

  test("project settings cannot self-grant bypass; only the user-scope Claude allowlist counts", async () => {
    expect(
      trustedClaudeWorkspacesFromUserSettings({
        externalAgents: { claudeCode: { trustedWorkspaces: ["/a"] } },
      }),
    ).toEqual(["/a"]);
    expect(trustedClaudeWorkspacesFromUserSettings(null)).toEqual([]);
    const f = fixture({ trusted: [] });
    await f.open("bypassPermissions");
    expect(f.approvals).toHaveLength(1);
  });

  test("a trusted Claude workspace runs bypass without a card, but Codex never inherits it", async () => {
    const trusted = fixture();
    // Entries are compared by canonical directory, so a trailing slash still matches.
    trusted.setTrusted([`${trusted.project}/`]);
    await trusted.open("bypassPermissions");
    expect(trusted.approvals).toEqual([]);
    expect(trusted.starts[0]!.mode).toBe("bypassPermissions");
    const codex = await trusted.authority.openSession({
      sessionId: "thread-codex",
      cwd: trusted.project,
      kind: "codex",
      mode: "bypassPermissions",
      requester: trusted.requester(),
    });
    expect(codex.approved).toBe(true);
    expect(trusted.approvals.map((approval) => approval.kind)).toEqual(["codex"]);
  });

  test("disconnect or navigation cancels a pending card without touching the running room", async () => {
    let signalSeen: AbortSignal | undefined;
    const f = fixture({
      decide: (_approval, signal) => {
        signalSeen = signal;
        return new Promise<Decision>(() => undefined);
      },
    });
    const running = await f.open("default");
    const pending = f.open("bypassPermissions").catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.authority.cancelRequester("mobile:tab-1");
    const error = await pending;
    expect((error as RoomModeAuthorizationError).code).toBe("cancelled");
    expect(signalSeen?.aborted).toBe(true);
    expect(f.manager.isOpen(running.roomId)).toBe(true);
    expect(f.manager.liveMode(running.roomId)).toBe("default");
    expect(f.starts).toHaveLength(1);
  });

  test("a newer request from the same view supersedes the older pending card", async () => {
    const f = fixture({ decide: () => new Promise<Decision>(() => undefined) });
    const first = f.open("bypassPermissions").catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.setDecide(async () => ({ approved: false }));
    const second = f.open("bypassPermissions").catch((e: unknown) => e);
    expect(((await first) as RoomModeAuthorizationError).code).toBe("cancelled");
    expect(((await second) as RoomModeAuthorizationError).code).toBe("denied");
    expect(f.starts).toEqual([]);
  });

  test("an approval is not applied when the requester or the project authorization changed meanwhile", async () => {
    const gone = fixture();
    gone.setDecide(async () => {
      gone.setOnline(false);
      return { approved: true };
    });
    await expect(gone.open("bypassPermissions")).rejects.toThrow("连接已断开");
    expect(gone.starts).toEqual([]);

    const unregistered = fixture();
    unregistered.setDecide(async () => {
      unregistered.setProjectAuthorized(false);
      return { approved: true };
    });
    await expect(unregistered.open("bypassPermissions")).rejects.toThrow("not registered");
    expect(unregistered.starts).toEqual([]);
  });

  test("an approval is bound to the room state it was asked for", async () => {
    const f = fixture();
    const running = await f.open("default");
    f.setDecide(async () => {
      // Another view restarts the room while the card is open (once the
      // closed process has been proven gone).
      f.manager.close(running.roomId);
      await until(() => !f.manager.isOpen(running.roomId));
      f.manager.open(running.roomId);
      return { approved: true };
    });
    await expect(f.open("bypassPermissions")).rejects.toThrow("状态已变化");
    expect(f.manager.getRoom(running.roomId)?.permissionMode).toBe("default");
    expect(f.starts.map((start) => start.mode)).toEqual(["default", "default"]);
  });

  test("a stored bypass mode is not a credential: implicit starts need a live Host grant", async () => {
    const f = fixture();
    const room = f.manager.createRoom({
      cwd: f.project,
      kind: "claude-code",
      permissionMode: "bypassPermissions",
      claudeSessionId: "thread-stored",
    });
    expect(() => f.manager.open(room.id)).toThrow("没有 Host 授权");
    expect(() => f.manager.send(room.id, "hello")).toThrow("没有 Host 授权");
    expect(f.starts).toEqual([]);

    // Reopening with bypass asks again even though metadata already says bypass.
    const reopened = await f.authority.openSession({
      sessionId: "thread-stored",
      cwd: f.project,
      kind: "claude-code",
      mode: "bypassPermissions",
      requester: f.requester(),
    });
    expect(reopened).toMatchObject({ roomId: room.id, approved: true, mode: "bypassPermissions" });
    expect(f.approvals).toHaveLength(1);

    // Same-mode reopen from another view joins the live process: no card, no restart.
    await f.authority.openSession({
      sessionId: "thread-stored",
      cwd: f.project,
      kind: "claude-code",
      mode: "bypassPermissions",
      requester: f.requester("desktop:7"),
    });
    expect(f.approvals).toHaveLength(1);
    expect(f.starts).toHaveLength(1);

    // An explicit close ends the grant; the next bypass start asks again.
    f.manager.close(room.id);
    await until(() => !f.manager.isOpen(room.id));
    expect(() => f.manager.open(room.id)).toThrow("没有 Host 授权");
  });

  test("a session record removed or rewritten while the old process exits blocks the replacement", async () => {
    for (const change of ["removed", "rewritten", "unregistered"] as const) {
      const f = fixture();
      const running = await f.open("default");
      f.holdExit();
      const switching = f.open("bypassPermissions").catch((e: unknown) => e);
      await until(() => f.exitWaiting());
      // The approval was granted for this exact tuple; it changes mid-handoff.
      if (change === "removed") f.setSessions([]);
      else if (change === "rewritten")
        f.setResolver(() => ({
          externalSessionId: "thread-1",
          kind: "claude-code",
          cwd: join(f.project, "elsewhere"),
        }));
      else f.setProjectAuthorized(false);
      f.releaseExit(true);
      const error = await switching;
      if (change === "unregistered") expect((error as Error).message).toContain("not registered");
      else expect((error as RoomModeAuthorizationError).code).toBe("not-authorized");
      // No replacement was spawned; the room is really stopped and told so.
      expect(f.starts.map((start) => start.mode)).toEqual(["default"]);
      expect(f.manager.isOpen(running.roomId)).toBe(false);
      expect(f.manager.getRoom(running.roomId)?.permissionMode).toBe("default");
      expect(f.stateChanges).toEqual([running.roomId]);
      // The grant minted for the approval does not outlive the failure.
      expect(f.authority.hasGrant(running.roomId, f.project, "claude-code")).toBe(false);
    }
  });

  test("room.create refuses an unapproved bypass instead of silently using default", async () => {
    const f = fixture();
    await expect(
      f.authority.resolveCreateMode("claude-code", f.project, "bypassPermissions"),
    ).rejects.toThrow("不能直接使用全放行");
    await expect(
      f.authority.resolveCreateMode("claude-code", f.project, "acceptEdits"),
    ).resolves.toEqual({ mode: "acceptEdits", trustedBypass: false });
    await expect(f.authority.resolveCreateMode("codex", f.project, undefined)).resolves.toEqual({
      mode: "default",
      trustedBypass: false,
    });
  });

  test("a stale same-mode bypass open cannot resurrect a grant another view revoked", async () => {
    const f = fixture();
    const first = await f.open("bypassPermissions");
    expect(f.approvals).toHaveLength(1);
    // View A reopens in bypass relying on the live grant G, and pauses at its
    // second project check.
    let calls = 0;
    let release: (() => void) | undefined;
    f.setPathGate(async () => {
      calls += 1;
      if (calls === 2) await new Promise<void>((r) => (release = r));
    });
    const stale = f
      .open("bypassPermissions", "claude-code", f.requester("mobile:tab-a"))
      .catch((e: unknown) => e);
    await until(() => release !== undefined);
    f.setPathGate(undefined);
    // View B downgrades the room to default, which ends G.
    const downgraded = await f.open("default", "claude-code", f.requester("desktop:7"));
    expect(downgraded).toMatchObject({ roomId: first.roomId, mode: "default", changed: true });
    expect(f.authority.hasGrant(first.roomId, f.project, "claude-code")).toBe(false);

    release!();
    const error = await stale;
    expect(error).toBeInstanceOf(RoomModeAuthorizationError);
    expect((error as RoomModeAuthorizationError).code).toBe("cancelled");
    // G stays revoked: neither re-minted nor restored by the failed request.
    expect(f.authority.hasGrant(first.roomId, f.project, "claude-code")).toBe(false);
    expect(f.manager.liveMode(first.roomId)).toBe("default");
    // The next bypass asks the Host again.
    f.setDecide(async () => ({ approved: false }));
    await expect(f.open("bypassPermissions")).rejects.toThrow("未获批准");
    expect(f.approvals).toHaveLength(2);
    expect(f.starts.map((start) => start.mode)).toEqual(["bypassPermissions", "default"]);
  });

  test("a failed bypass switch rolls back only its own grant, never one installed meanwhile", async () => {
    const f = fixture();
    const running = await f.open("default");
    f.holdExit();
    const switching = f.open("bypassPermissions").catch((e: unknown) => e);
    await until(() => f.exitWaiting());
    // While the old process exits, the Host replaces this room's grant.
    f.authority.revoke(running.roomId);
    f.authority.grantTrusted(running.roomId, f.project, "claude-code");
    f.releaseExit(true);
    const error = await switching;
    expect((error as RoomModeAuthorizationError).code).toBe("cancelled");
    expect((error as Error).message).toContain("撤销");
    // The other operation's grant survives this request's rollback.
    expect(f.authority.hasGrant(running.roomId, f.project, "claude-code")).toBe(true);
    expect(f.starts.map((start) => start.mode)).toEqual(["default"]);
    expect(f.manager.getRoom(running.roomId)?.permissionMode).toBe("default");
  });

  for (const leave of ["navigation", "disconnect"] as const)
    test(`a requester ${leave} while the old process exits leaves the room stopped, never a late bypass start`, async () => {
      const f = fixture();
      const running = await f.open("default");
      f.holdExit();
      const switching = f.open("bypassPermissions").catch((e: unknown) => e);
      await until(() => f.exitWaiting());
      if (leave === "navigation") f.authority.cancelRequester("mobile:tab-1");
      else f.setOnline(false);
      f.releaseExit(true);
      const error = await switching;
      expect(error).toBeInstanceOf(RoomModeAuthorizationError);
      expect((error as RoomModeAuthorizationError).code).toBe(
        leave === "navigation" ? "cancelled" : "requester-gone",
      );
      // The old process really stopped; no replacement, no mode change, no grant.
      expect(f.starts.map((start) => start.mode)).toEqual(["default"]);
      expect(f.manager.isOpen(running.roomId)).toBe(false);
      expect(f.manager.liveMode(running.roomId)).toBeUndefined();
      expect(f.manager.getRoom(running.roomId)?.permissionMode).toBe("default");
      expect(f.authority.hasGrant(running.roomId, f.project, "claude-code")).toBe(false);
      // Every view is told the room stopped, not only the departed requester.
      expect(f.stateChanges).toEqual([running.roomId]);
      // A later attempt still works from the real stopped state.
      f.setOnline(true);
      await expect(f.open("default")).resolves.toMatchObject({ status: "running" });
    });

  test("the approval names the CLI's real session: a wrong session, kind or cwd is refused before any card", async () => {
    const f = fixture();
    f.setSessions([{ externalSessionId: "thread-1", kind: "claude-code", cwd: f.project }]);
    // Another authorized directory with no record of this session.
    const other = join(f.project, "other");
    mkdirSync(other);
    for (const input of [
      { sessionId: "thread-forged", kind: "claude-code", cwd: f.project },
      { sessionId: "thread-1", kind: "codex", cwd: f.project },
      { sessionId: "thread-1", kind: "claude-code", cwd: other },
    ] as const) {
      const error = await f.authority
        .openSession({ ...input, mode: "bypassPermissions", requester: f.requester() })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RoomModeAuthorizationError);
      expect((error as RoomModeAuthorizationError).code).toBe("not-authorized");
    }
    // A resolver answering with another identity is not accepted either.
    f.setResolver(() => ({ externalSessionId: "thread-2", kind: "claude-code", cwd: f.project }));
    await expect(f.open("bypassPermissions")).rejects.toThrow("CLI 会话记录");
    expect(f.approvals).toEqual([]);
    expect(f.starts).toEqual([]);
    expect(f.manager.listRooms()).toEqual([]);

    // The real tuple is approved and started as exactly that session.
    f.setResolver((target) =>
      target.externalSessionId === "thread-1" && target.kind === "claude-code"
        ? { externalSessionId: "thread-1", kind: "claude-code", cwd: f.project }
        : null,
    );
    const opened = await f.open("bypassPermissions");
    expect(f.approvals).toHaveLength(1);
    expect(f.approvals[0]).toMatchObject({
      sessionId: "thread-1",
      kind: "claude-code",
      cwd: f.project,
    });
    expect(f.manager.getRoom(opened.roomId)).toMatchObject({
      claudeSessionId: "thread-1",
      kind: "claude-code",
      cwd: f.project,
    });
  });
});
