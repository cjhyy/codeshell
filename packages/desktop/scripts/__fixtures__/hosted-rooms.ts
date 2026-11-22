import { fork, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { encodeCwd } from "@cjhyy/code-shell-capability-coding/orchestration";
import {
  roomProcessLauncher,
  RoomHistoryReader,
  type MobileServerEvent,
} from "@cjhyy/code-shell-server/mobile-remote";
import { PrivateHostPeer, type PrivatePort } from "../../src/host/native-peer.js";
import { hostedRooms } from "../../src/host/rooms/service.js";
import { NativeRooms } from "../../src/main/desktop-host/rooms-client.js";

const root = realpathSync(process.argv[2]!);
const cwd = join(root, ".code-shell", "no-repo");
const journal = join(root, "activity.jsonl");
const text = (message: string) => appendFileSync(journal, message + "\n");
const observed = () => readFileSync(journal, "utf8").trim().split("\n");
const here = fileURLToPath(import.meta.url);
function port(channel: NodeJS.Process | ChildProcess): PrivatePort {
  return {
    send: (value) => channel.send!(value as object),
    listen: (receive, closed) => {
      channel.on("message", receive);
      channel.once("disconnect", closed);
    },
    close: () => {
      if (channel.connected) channel.disconnect();
    },
  };
}
async function until(ok: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (ok()) return;
    await wait(10);
  }
  throw Error("room fixture timeout: " + observed());
}
if (process.argv[3] === "utility") {
  let rooms: ReturnType<typeof hostedRooms>;
  const peer = new PrivateHostPeer(
    port(process),
    (method, input, signal) => rooms.run(method, input, signal),
    () => {
      rooms.close();
      process.exit();
    },
    (method, key) => rooms.notice(method, key),
  );
  rooms = hostedRooms(() => peer, root, {
    models: async () => [],
    read: () => async () => {
      throw Error("Unexpected external read");
    },
    history: {
      roomHistory: async (method, p) => {
        const reader = new RoomHistoryReader(join(root, "mobile-remote", "rooms"));
        assert.equal(reader.rootIdentity, p.rootIdentity);
        if (method !== "rooms/messages" || !("sinceSeq" in p))
          throw Error("Unexpected history page");
        return reader.getMessages(p.roomId, p.sinceSeq) as never;
      },
    },
    createAgent: (room, emit) => {
      let active = false;
      return {
        start() {
          active = true;
          text("start " + room.permissionMode);
        },
        stop() {
          active = false;
        },
        isRunning: () => active,
        send(value) {
          text("send " + value);
          if (value === "crash-during-write") process.kill(process.pid, "SIGKILL");
          if (value !== "keep-busy")
            setTimeout(() => emit({ type: "turn_end", reason: "complete" }), 15);
          return active;
        },
      };
    },
  });
} else if (process.argv[3] === "launcher") {
  const launch = roomProcessLauncher(join(root, "guard"), ["room1", "session1"]);
  // Simulate an independent CLI finishing a turn after its launcher dies.
  const proc = launch(
    process.execPath,
    [
      "-e",
      'const fs=require("node:fs");fs.writeFileSync(process.argv[1],"started");setTimeout(()=>{},30000)',
      join(root, "running"),
    ],
    {
      detached: true,
      cwd: root,
      env: process.env,
    },
  );
  process.send!({ pid: proc.pid });
  process.on("message", () => {});
} else {
  mkdirSync(cwd, { recursive: true });
  writeFileSync(journal, "");
  const sessionId = "fixture-thread";
  const dir = join(root, ".claude", "projects", encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, sessionId + ".jsonl"),
    JSON.stringify({
      type: "user",
      cwd,
      sessionId,
      message: { role: "user", content: "fixture origin" },
    }) + "\n",
  );
  const output: MobileServerEvent[] = [];
  let valid = true,
    modal = 0;
  let doc = new AbortController();
  const sender = { sender: { id: 18 } } as Electron.IpcMainInvokeEvent;
  let peer: PrivateHostPeer;
  const rooms = new NativeRooms(() => peer, {
    document: () => doc.signal,
    listBackground: async () => [],
    projects: async () => {},
    remote: {
      onlineDeviceIds: () => (valid ? ["phone"] : []),
      hasAuthenticatedViewer: (v, d) => valid && v === "view" && d === "phone",
      isTrustedDevice: (d) => valid && d === "phone",
      sendToViewer: (_v, e) => {
        output.push(e);
      },
      sendToDevice: (_d, e) => {
        output.push(e);
      },
      broadcast: (e) => {
        output.push(e);
      },
    },
    uploads: {
      claim() {
        throw Error("No upload in fixture");
      },
      retain() {},
      release: async () => {},
      finalize: async () => {},
      discard: async () => {},
    },
    confirm: async (_request, _origin, signal) => {
      modal++;
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      return { approved: true };
    },
    publish: (event) => {
      if (event.type !== "room.changed") output.push(event);
    },
  });
  const start = () => {
    const child = fork(here, [root, "utility"], {
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    peer = new PrivateHostPeer(
      port(child),
      (m, i, s) => rooms.handle(m, i, s),
      () => rooms.disconnect(),
      (m, i) => rooms.notice(m, i),
    );
    void rooms.connected().catch(() => {});
    return child;
  };
  const phone = (e: object) =>
    rooms.phone({ ...e, deviceId: "phone", viewerId: "view" } as Parameters<
      NativeRooms["phone"]
    >[0]);
  const list = () =>
    rooms.desktop(sender, { op: "list" }) as Promise<Array<{ id: string; open: boolean }>>;
  let child = start();
  try {
    const room = (await rooms.desktop(sender, {
      op: "create",
      input: { cwd, name: "fixture" },
    })) as { id: string };
    await phone({ type: "room.list" });
    assert.ok(
      output.some((e) => e.type === "room.list.ok" && e.rooms.some((r) => r.id === room.id)),
    );
    const packet = { type: "room.send", roomId: room.id, clientMessageId: "once", text: "first" };
    await phone(packet);
    await phone(packet);
    assert.equal(observed().filter((l) => l === "send first").length, 1);
    await rooms.desktop(sender, { op: "close", roomId: room.id });
    const opening = rooms.desktop(sender, {
      op: "openSession",
      kind: "claude-code",
      mode: "bypassPermissions",
      sessionId,
      cwd,
    });
    const cancelled = assert.rejects(opening);
    await until(() => modal === 1);
    doc.abort();
    await cancelled;
    assert.equal(observed().includes("start bypassPermissions"), false);
    doc = new AbortController();
    const request = phone({
      type: "ccRoom.openSession",
      kind: "claude-code",
      mode: "bypassPermissions",
      sessionId,
      cwd,
      requestId: "open-1",
    });
    const settled = request.catch(() => {});
    await until(() => output.some((e) => e.type === "ccRoom.approvalRequest"));
    const card = [...output].reverse().find((e) => e.type === "ccRoom.approvalRequest");
    assert.ok(card?.type === "ccRoom.approvalRequest");
    valid = false;
    rooms.left("view");
    await settled;
    await assert.rejects(
      phone({
        type: "ccRoom.respondApproval",
        roomId: card.roomId,
        requestId: card.req.requestId,
        decision: { behavior: "allow" },
      }),
    );
    assert.equal(observed().includes("start bypassPermissions"), false);
    const died = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await died;
    valid = true;
    child = start();
    assert.ok((await list()).some((r) => r.id === room.id && !r.open));
    await phone(packet);
    assert.equal(observed().filter((l) => l === "send first").length, 1);
    const uncertain = { ...packet, text: "crash-during-write", clientMessageId: "uncertain-once" };
    const stopped = new Promise((resolve) => child.once("exit", resolve));
    await assert.rejects(phone(uncertain));
    await stopped;
    child = start();
    await phone(uncertain);
    assert.equal(observed().filter((l) => l === "send crash-during-write").length, 1);
    assert.ok(
      output.some(
        (e) => e.type === "room.error" && e.clientMessageId === "uncertain-once" && e.uncertain,
      ),
    );
    const linked = (await rooms.desktop(sender, {
      op: "linked",
      cwd,
      sessionId,
      kind: "claude-code",
    })) as { roomId: string };
    const snapshot = (await rooms.desktop(sender, {
      op: "subscribe",
      roomId: linked.roomId,
      sessionId,
      cwd,
      kind: "claude-code",
    })) as { active: boolean; messages: unknown[] };
    assert.ok(snapshot.active);
    assert.ok(snapshot.messages.length > 0);
    await phone({
      type: "ccRoom.subscribeTranscript",
      roomId: linked.roomId,
      sessionId,
      cwd,
      kind: "claude-code",
      limit: 10,
    });
    const count = () => output.filter((e) => e.type === "ccRoom.transcriptSubscribed").length;
    const before = count();
    assert.ok(before > 0);
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exit;
    child = start();
    await until(() => count() > before);
    await rooms.desktop(sender, { op: "unsubscribe", roomId: linked.roomId });
    await phone({ ...packet, clientMessageId: "busy", text: "keep-busy", queue: true });
    await phone({ ...packet, clientMessageId: "pending", text: "awaiting-human", queue: true });
    const queues = () =>
      output.filter(
        (e) => e.type === "queue.state" && e.target.kind === "room" && e.target.roomId === room.id,
      );
    await until(() =>
      queues().some(
        (e) =>
          e.type === "queue.state" && e.entries.some((item) => item.clientMessageId === "pending"),
      ),
    );
    const oldQueue = queues().at(-1)!;
    assert.ok(oldQueue.type === "queue.state");
    const retired = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await retired;
    child = start();
    await until(() =>
      queues().some(
        (e) => e.type === "queue.state" && e.epoch !== oldQueue.epoch && e.entries.length === 0,
      ),
    );
    assert.ok(!observed().includes("send awaiting-human"));
  } finally {
    peer!.close();
    child.kill();
  }
  const launcher = fork(here, [root, "launcher"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  let pid: number | undefined;
  const launch = roomProcessLauncher(join(root, "guard"), ["room1", "session1"]);
  try {
    pid = await new Promise<number>((resolve, reject) => {
      launcher.once("message", (v) => resolve((v as { pid: number }).pid));
      launcher.once("error", reject);
    });
    await until(() => {
      try {
        return readFileSync(join(root, "running"), "utf8") === "started";
      } catch {
        return false;
      }
    });
    assert.throws(
      () => launch(process.execPath, ["-v"], { env: process.env, cwd: root }),
      /尚未确认退出/,
    );
    const gone = new Promise<void>((r) => launcher.once("exit", () => r()));
    launcher.kill("SIGKILL");
    await gone;
    if (process.platform !== "win32") {
      assert.throws(
        () => launch(process.execPath, ["-v"], { env: process.env, cwd: root }),
        /尚未确认退出/,
      );
      process.kill(pid, "SIGKILL");
      pid = undefined;
    }
    let replacement: ReturnType<typeof launch> | undefined;
    await until(() => {
      try {
        replacement = launch(process.execPath, ["-v"], { env: process.env, cwd: root });
        return true;
      } catch {
        return false;
      }
    });
    await new Promise<void>((r, j) => {
      replacement!.on("exit", (code) => (code === 0 ? r() : j(Error(String(code)))));
      replacement!.on("error", j);
    });
  } finally {
    launcher.kill();
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* It exited with its Windows guard. */
      }
  }
  console.log("PASS hosted rooms");
}
