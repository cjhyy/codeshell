import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _setPtyForTest,
  ptyKill,
  ptyKillAll,
  ptyResize,
  ptyStart,
  ptyWrite,
} from "./pty-service.js";

interface FakePty {
  pid: number;
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
  return {
    pid: 1234,
    writes: [],
    resizes: [],
    kills: 0,
    onData: () => {},
    onExit: () => {},
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

function makeWebContents(id: number) {
  return {
    id,
    isDestroyed: () => false,
    send: () => {},
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
