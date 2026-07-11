import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, EngineResult } from "../engine/engine.js";
import { SessionManager } from "../session/session-manager.js";
import { ChatSessionManager } from "./chat-session-manager.js";

function result(sessionId: string): EngineResult {
  return {
    text: "ok",
    reason: "completed",
    sessionId,
    turnCount: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ChatSessionManager serialized lifecycle", () => {
  it("fences a closing Engine's late save before reopening the same sid", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "chat-generation-fence-"));
    tempDirs.push(storageDir);
    const sid = "same-sid";
    const seed = new SessionManager(storageDir);
    seed.create("/tmp/project", "model", "provider", sid);

    const oldRunStarted = deferred();
    const releaseOldRun = deferred();
    const staleSaveResults: boolean[] = [];
    let engineNumber = 0;
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        const number = ++engineNumber;
        const sessions = new SessionManager(storageDir);
        const engine = {
          getSessionManager: () => sessions,
          isHeadless: () => false,
          async run(): Promise<EngineResult> {
            const bundle = sessions.resume(sid);
            if (number === 1) {
              oldRunStarted.resolve();
              await releaseOldRun.promise;
              bundle.state.title = "stale old engine";
              staleSaveResults.push(sessions.saveState(bundle.state));
            } else {
              bundle.state.title = "fresh new engine";
              sessions.saveState(bundle.state);
            }
            return result(sid);
          },
        } as unknown as Engine;
        return engine;
      },
    });

    const oldSession = manager.getOrCreate(sid, {} as never);
    const oldTurn = oldSession.enqueueTurn("old", {});
    await oldRunStarted.promise;

    const closing = manager.close(sid);
    const reopening = Promise.resolve(manager.getOrCreate(sid, {} as never));
    let reopened = false;
    void reopening.then(() => {
      reopened = true;
    });
    await Promise.resolve();
    expect(reopened).toBe(false);

    releaseOldRun.resolve();
    await oldTurn;
    await closing;
    const newSession = await reopening;
    await newSession.enqueueTurn("new", {});

    expect(staleSaveResults).toEqual([false]);
    expect(seed.resume(sid).state.title).toBe("fresh new engine");
    expect(engineNumber).toBe(2);
  });

  it("keeps the live Map entry until the active run settles", async () => {
    const started = deferred();
    const release = deferred();
    let engines = 0;
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        engines += 1;
        return {
          isHeadless: () => false,
          async run(): Promise<EngineResult> {
            started.resolve();
            await release.promise;
            return result("settle-sid");
          },
        } as unknown as Engine;
      },
    });
    const session = manager.getOrCreate("settle-sid", {} as never);
    const turn = session.enqueueTurn("work", {});
    await started.promise;

    const closing = manager.close("settle-sid");
    expect(manager.get("settle-sid")).toBe(session);
    expect(manager.sessionCount()).toBe(1);

    release.resolve();
    await turn;
    await closing;
    expect(manager.get("settle-sid")).toBeUndefined();
    expect(manager.sessionCount()).toBe(0);

    await Promise.resolve(manager.getOrCreate("settle-sid", {} as never));
    expect(engines).toBe(2);
  });

  it("preserves ordinary close-open-run serialization", async () => {
    const runs: number[] = [];
    let engines = 0;
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        const number = ++engines;
        return {
          isHeadless: () => false,
          async run(): Promise<EngineResult> {
            runs.push(number);
            return result("serial-sid");
          },
        } as unknown as Engine;
      },
    });

    const first = manager.getOrCreate("serial-sid", {} as never);
    await first.enqueueTurn("first", {});
    await manager.close("serial-sid");
    const second = await Promise.resolve(manager.getOrCreate("serial-sid", {} as never));
    await second.enqueueTurn("second", {});

    expect(runs).toEqual([1, 2]);
    expect(manager.get("serial-sid")).toBe(second);
  });
});
