import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { handleClientEvent, type OrchestratorCtx } from "./handle-client-event.js";
import { handleCcRoomEvent } from "./handle-cc-room-event.js";

test("mobile CLI discovery exposes its total and can load sessions beyond both default limits", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mobile-cli-pages-"));
  const directory = join(homedir(), ".claude", "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"));
  const replies: any[] = [];
  mkdirSync(directory, { recursive: true });
  try {
    for (let index = 0; index < 22; index++) {
      const sessionId = `mobile-cli-${index}`;
      const file = join(directory, `${sessionId}.jsonl`);
      writeFileSync(
        file,
        JSON.stringify({
          type: "user",
          sessionId,
          cwd: workspace,
          message: { role: "user", content: `history ${index}` },
        }) + "\n",
      );
      const modified = Date.now() - (index === 0 ? 30 * 24 * 60 * 60 * 1000 : index * 1000);
      utimesSync(file, new Date(modified), new Date(modified));
    }
    const ctx = {
      remote: { sendToViewer: (_viewer: string, event: unknown) => replies.push(event) },
    } as unknown as OrchestratorCtx;
    await handleCcRoomEvent(ctx, {
      type: "ccRoom.listSessions",
      cwd: workspace,
      kind: "claude-code",
      viewerId: "viewer",
    });
    expect(replies[0]).toMatchObject({ type: "ccRoom.listSessions.ok", total: 22, all: false });
    expect(replies[0].sessions).toHaveLength(20);
    await handleCcRoomEvent(ctx, {
      type: "ccRoom.listSessions",
      cwd: workspace,
      kind: "claude-code",
      all: true,
      viewerId: "viewer",
    });
    expect(replies[1]).toMatchObject({ type: "ccRoom.listSessions.ok", total: 22, all: true });
    expect(replies[1].sessions).toHaveLength(22);
    expect(replies[1].sessions.some((session) => session.sessionId === "mobile-cli-0")).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("mobile session pages retain older project sessions and reply only to the requesting viewer", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mobile-session-pages-"));
  const root = sessionsRoot();
  const prefix = `mobile-page-${Date.now()}-`;
  const owned: string[] = [];
  const replies: Array<{ viewer: string; event: any }> = [];
  const seed = (name: string, cwd: string, at: number, provider = "native") => {
    const id = `${prefix}${name}`;
    const directory = join(root, id);
    mkdirSync(directory, { recursive: true });
    owned.push(directory);
    writeFileSync(
      join(directory, "state.json"),
      JSON.stringify({
        sessionId: id,
        origin: "desktop",
        parentSessionId: null,
        cwd,
        title: name,
        provider,
        model: `${provider}:model`,
      }),
    );
    utimesSync(directory, new Date(at), new Date(at));
    return id;
  };
  try {
    const project = join(workspace, "project");
    const unrelated = join(workspace, "unrelated");
    mkdirSync(project);
    mkdirSync(unrelated);
    for (let index = 0; index < 105; index++) seed(`other-${index}`, unrelated, 20_000 + index);
    for (let index = 0; index < 101; index++)
      seed(`selected-${index}`, project, 10_000 + index, index % 2 ? "codex" : "claude-code");
    const ctx = {
      remote: {
        sendToViewer: (viewer: string, event: unknown) => replies.push({ viewer, event }),
        sendToDevice: () => {
          throw new Error("A catalog page must not overwrite another tab");
        },
        broadcast: () => {
          throw new Error("A catalog page must not be broadcast");
        },
      },
      getBridge: () => ({ getLastRunContext: () => ({}) }),
      deviceState: () => ({}),
      mobileSessionCwds: new Map(),
    } as unknown as OrchestratorCtx;
    await handleClientEvent(ctx, {
      type: "session.list",
      requestId: "first",
      cwds: [project],
      deviceId: "device",
      viewerId: "viewer-a",
    });
    const first = replies[0]!;
    expect(first.viewer).toBe("viewer-a");
    expect(first.event.requestId).toBe("first");
    expect(first.event.sessions).toHaveLength(100);
    expect(first.event.sessions[0]).toMatchObject({
      cwd: project,
      provider: "claude-code",
      model: "claude-code:model",
    });
    expect(first.event.nextCursor).toBeString();
    await handleClientEvent(ctx, {
      type: "session.list",
      requestId: "second",
      cwds: [project],
      cursor: first.event.nextCursor,
      deviceId: "device",
      viewerId: "viewer-a",
    });
    expect(replies[1]!.event.sessions.map((session) => session.id)).toEqual([
      `${prefix}selected-0`,
    ]);
    expect(replies[1]!.event.nextCursor).toBeNull();
  } finally {
    for (const directory of owned) rmSync(directory, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
