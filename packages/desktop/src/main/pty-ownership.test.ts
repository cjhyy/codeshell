import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setPtyForTest,
  ptyAttachRemote,
  ptyDetachRemote,
  ptyKill,
  ptyKillAll,
  ptyList,
  ptyPruneRemoteViewers,
  ptyRemoteKill,
  ptyRemoteResize,
  ptyRemoteStart,
  ptyRemoteWrite,
  ptyResize,
  ptyRevokeRemoteAccess,
  ptyStart,
  ptyWrite,
} from "./pty-service.js";
import { RemoteTerminalPolicy, RemoteTerminals } from "./mobile-remote/remote-terminals.js";

interface FakePty {
  pid: number;
  emit: (data: string) => void;
  exit: (exitCode: number) => void;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  kills: number;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

function makePty(): FakePty {
  let dataCb: (data: string) => void = () => {};
  let exitCb: (e: { exitCode: number; signal?: number }) => void = () => {};
  return {
    pid: 1234,
    writes: [],
    resizes: [],
    kills: 0,
    emit: (data) => dataCb(data),
    exit: (exitCode) => exitCb({ exitCode }),
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    write(data: string) {
      this.writes.push(data);
    },
    resize(cols: number, rows: number) {
      this.resizes.push({ cols, rows });
    },
    kill() {
      this.kills += 1;
    },
  };
}

function makeWebContents(id: number, sent: Array<[string, unknown]> = []) {
  return {
    id,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push([channel, payload]),
    once: () => {},
    on: () => {},
  } as any;
}

beforeEach(() => {
  ptyKillAll();
  _setPtyForTest(null);
});

afterEach(() => {
  ptyKillAll();
  _setPtyForTest(null);
});

describe("PTY sender ownership", () => {
  test("write, resize, and kill require the starting webContents", () => {
    const pty = makePty();
    const owner = makeWebContents(1);
    const intruder = makeWebContents(2);
    _setPtyForTest({ spawn: () => pty });

    expect(ptyStart(owner, { sessionId: "pty-session", cwd: process.cwd() })).toEqual({
      ok: true,
      pid: 1234,
    });

    ptyWrite(intruder, "pty-session", "bad");
    ptyResize(intruder, "pty-session", 120, 40);
    ptyKill(intruder, "pty-session");

    expect(pty.writes).toEqual([]);
    expect(pty.resizes).toEqual([]);
    expect(pty.kills).toBe(0);

    ptyWrite(owner, "pty-session", "ok");
    ptyResize(owner, "pty-session", 90, 30);
    ptyKill(owner, "pty-session");

    expect(pty.writes).toEqual(["ok"]);
    expect(pty.resizes).toEqual([{ cols: 90, rows: 30 }]);
    expect(pty.kills).toBe(1);
  });

  test("reattach requires the starting webContents", () => {
    const pty = makePty();
    const owner = makeWebContents(1);
    const intruder = makeWebContents(2);
    _setPtyForTest({ spawn: () => pty });

    expect(ptyStart(owner, { sessionId: "pty-session", cwd: process.cwd() })).toEqual({
      ok: true,
      pid: 1234,
    });
    expect(ptyStart(intruder, { sessionId: "pty-session" })).toEqual({
      ok: false,
      detail: "pty session is owned by another webContents",
    });

    ptyWrite(intruder, "pty-session", "bad");
    expect(pty.writes).toEqual([]);

    ptyWrite(owner, "pty-session", "ok");
    expect(pty.writes).toEqual(["ok"]);
  });
});

function viewer(key: string) {
  const out = { key, data: [] as string[], exits: [] as number[] };
  return {
    out,
    viewer: {
      key,
      onData: (data: string) => out.data.push(data),
      onExit: (code: number) => out.exits.push(code),
    },
  };
}

describe("remote viewers share the Desktop pty", () => {
  const id = "term:p::s:terminal-1@1";

  test("a phone sees the same scrollback and live output, and its input reaches the shell", () => {
    const pty = makePty();
    const sent: Array<[string, unknown]> = [];
    const owner = makeWebContents(1, sent);
    _setPtyForTest({ spawn: () => pty });
    ptyStart(owner, { sessionId: id, cwd: process.cwd(), cols: 120, rows: 40 });
    pty.emit("$ claude\r\n");

    const phone = viewer("phone");
    const attached = ptyAttachRemote(id, phone.viewer, { cols: 120, rows: 40 });
    expect(attached?.replay).toBe("$ claude\r\n");
    expect(attached?.info).toMatchObject({ id, origin: "desktop", pid: 1234 });
    expect(sent).toContainEqual(["pty:remoteViewers", { sessionId: id, count: 1 }]);

    pty.emit("> hi");
    expect(phone.out.data).toEqual(["> hi"]);
    expect(sent).toContainEqual(["pty:data", { sessionId: id, data: "> hi" }]);

    ptyRemoteWrite(id, "phone", "y\r");
    ptyRemoteWrite(id, "stranger", "rm -rf ~\r");
    expect(pty.writes).toEqual(["y\r"]);

    pty.exit(0);
    expect(phone.out.exits).toEqual([0]);
    expect(ptyList()).toEqual([]);
  });

  test("whoever typed last decides the size", () => {
    const pty = makePty();
    const owner = makeWebContents(1);
    _setPtyForTest({ spawn: () => pty });
    ptyStart(owner, { sessionId: id, cwd: process.cwd(), cols: 120, rows: 40 });
    ptyAttachRemote(id, viewer("phone").viewer, { cols: 50, rows: 30 });
    expect(pty.resizes).toEqual([{ cols: 50, rows: 30 }]);

    ptyWrite(owner, id, "a");
    expect(pty.resizes.at(-1)).toEqual({ cols: 120, rows: 40 });
    ptyRemoteWrite(id, "phone", "b");
    expect(pty.resizes.at(-1)).toEqual({ cols: 50, rows: 30 });
    ptyRemoteWrite(id, "phone", "c");
    expect(pty.resizes).toHaveLength(3);

    ptyRemoteResize(id, "phone", 60, 30);
    expect(pty.resizes.at(-1)).toEqual({ cols: 60, rows: 30 });
    ptyRemoteResize(id, "stranger", 10, 10);
    expect(pty.resizes.at(-1)).toEqual({ cols: 60, rows: 30 });
  });

  test("only the most recently active client answers terminal queries", () => {
    const pty = makePty();
    const owner = makeWebContents(1);
    _setPtyForTest({ spawn: () => pty });
    ptyStart(owner, { sessionId: id, cwd: process.cwd() });
    ptyWrite(owner, id, "\x1b]11;rgb:desk\x07", true);
    expect(pty.writes).toEqual(["\x1b]11;rgb:desk\x07"]);

    ptyAttachRemote(id, viewer("phone").viewer, { cols: 80, rows: 24 });
    ptyWrite(owner, id, "desk-reply", true);
    ptyRemoteWrite(id, "phone", "phone-reply", true);
    expect(pty.writes.slice(1)).toEqual(["phone-reply"]);

    // Typing on Desktop makes it the responder again; a reply never steals it.
    ptyWrite(owner, id, "k");
    ptyRemoteWrite(id, "phone", "phone-reply-2", true);
    ptyWrite(owner, id, "desk-reply-2", true);
    expect(pty.writes.slice(2)).toEqual(["k", "desk-reply-2"]);

    ptyRemoteWrite(id, "phone", "p");
    ptyDetachRemote(id, "phone");
    ptyWrite(owner, id, "desk-reply-3", true);
    expect(pty.writes.at(-1)).toBe("desk-reply-3");
  });

  test("detach, prune and kill are limited to attached viewers", () => {
    const pty = makePty();
    _setPtyForTest({ spawn: () => pty });
    ptyStart(makeWebContents(1), { sessionId: id, cwd: process.cwd() });
    const phone = viewer("phone");
    ptyAttachRemote(id, phone.viewer, { cols: 80, rows: 24 });
    ptyRemoteKill(id, "stranger");
    expect(pty.kills).toBe(0);

    ptyDetachRemote(id, "phone");
    pty.emit("after detach");
    expect(phone.out.data).toEqual([]);
    ptyRemoteKill(id, "phone");
    expect(pty.kills).toBe(0);

    ptyAttachRemote(id, phone.viewer, { cols: 80, rows: 24 });
    ptyPruneRemoteViewers((key) => key !== "phone");
    ptyRemoteWrite(id, "phone", "x");
    expect(pty.writes).toEqual([]);
  });

  test("switching remote access off ends remote-only shells and detaches the rest", () => {
    const desktopPty = makePty();
    const remotePty = makePty();
    const queue = [desktopPty, remotePty];
    _setPtyForTest({ spawn: () => queue.shift() });
    ptyStart(makeWebContents(1), { sessionId: id, cwd: process.cwd() });
    expect(ptyRemoteStart({ sessionId: "term:remote::r1", cwd: process.cwd() }).ok).toBe(true);
    expect(ptyList().map((item) => item.origin)).toEqual(["desktop", "remote"]);
    ptyAttachRemote(id, viewer("phone").viewer, { cols: 80, rows: 24 });

    ptyRevokeRemoteAccess();
    expect(remotePty.kills).toBe(1);
    expect(desktopPty.kills).toBe(0);
    ptyRemoteWrite(id, "phone", "x");
    expect(desktopPty.writes).toEqual([]);
    expect(ptyList().map((item) => item.id)).toEqual([id]);
  });
});

describe("RemoteTerminals (phone protocol)", () => {
  function setup(enabled: boolean) {
    const sent: Array<{ viewerId: string; event: { type: string; [key: string]: unknown } }> = [];
    const broadcasts: unknown[] = [];
    let state = enabled;
    const online = new Set(["v1"]);
    const terminals = new RemoteTerminals({
      remote: {
        sendToViewer: (viewerId, event) => sent.push({ viewerId, event: event as never }),
        hasAuthenticatedViewer: (viewerId) => online.has(viewerId),
        broadcast: (event) => broadcasts.push(event),
      },
      policy: {
        get enabled() {
          return state;
        },
        set: (next: boolean) => {
          state = next;
        },
      },
      projectCwd: (projectId) => {
        if (projectId !== "p1") throw new Error("unknown");
        return process.cwd();
      },
    });
    return { terminals, sent, broadcasts, online };
  }
  const from = { deviceId: "d1", viewerId: "v1" };

  test("everything but the list is refused while the Desktop switch is off", () => {
    const { terminals, sent } = setup(false);
    terminals.handle({ type: "terminal.list", ...from });
    terminals.handle({ type: "terminal.open", requestId: "r1", cols: 80, rows: 24, ...from });
    expect(sent.map((item) => item.event)).toEqual([
      { type: "terminal.list.ok", enabled: false, terminals: [] },
      {
        type: "terminal.error",
        requestId: "r1",
        code: "disabled",
        message: "桌面端没有开启远程终端。",
      },
    ]);
  });

  test("a phone opens a new terminal in a project and receives coalesced output", async () => {
    const pty = makePty();
    _setPtyForTest({ spawn: () => pty });
    const { terminals, sent } = setup(true);
    terminals.handle({
      type: "terminal.open",
      requestId: "r1",
      projectId: "p1",
      cols: 90,
      rows: 30,
      ...from,
    });
    const opened = sent[0].event as { type: string; terminal: { id: string; origin: string } };
    expect(opened).toMatchObject({ type: "terminal.opened", requestId: "r1", replay: "" });
    expect(opened.terminal.origin).toBe("remote");

    pty.emit("a");
    pty.emit("b");
    expect(sent).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent[1].event).toEqual({
      type: "terminal.data",
      terminalId: opened.terminal.id,
      data: "ab",
    });

    terminals.handle({
      type: "terminal.input",
      terminalId: opened.terminal.id,
      data: "ls\r",
      ...from,
    });
    expect(pty.writes).toEqual(["ls\r"]);

    terminals.handle({
      type: "terminal.open",
      requestId: "r2",
      projectId: "nope",
      cols: 80,
      rows: 24,
      ...from,
    });
    expect(sent.at(-1)?.event).toMatchObject({
      type: "terminal.error",
      requestId: "r2",
      code: "not_found",
    });
  });

  test("a closed tab stops receiving output; turning the switch off ends remote shells", async () => {
    const pty = makePty();
    _setPtyForTest({ spawn: () => pty });
    const { terminals, sent, broadcasts, online } = setup(true);
    terminals.handle({ type: "terminal.open", requestId: "r1", cols: 80, rows: 24, ...from });
    online.delete("v1");
    pty.emit("secret");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toHaveLength(1);

    terminals.setEnabled(false);
    expect(pty.kills).toBe(1);
    expect(broadcasts).toEqual([{ type: "terminal.list.ok", enabled: false, terminals: [] }]);
  });

  test("the switch persists and defaults to off", () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-terminal-policy-"));
    try {
      const file = join(dir, "mobile-remote", "terminal.json");
      expect(new RemoteTerminalPolicy(file).enabled).toBe(false);
      new RemoteTerminalPolicy(file).set(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ enabled: true });
      expect(new RemoteTerminalPolicy(file).enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
