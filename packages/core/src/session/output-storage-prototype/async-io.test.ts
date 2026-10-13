import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock } from "../../utils/lockfile.js";
import type { SessionState } from "../../types.js";
import { decodeStateBytes, encodeState, type DecodedState } from "./codec.js";
import { createFixtureRoot, JOURNAL_LIMIT } from "./io.js";
import { LeaseFs, reservePath, releasePath, poisonPath, type FixtureIOHooks } from "./lease-fs.js";
import {
  appendAsyncUnderLease,
  AsyncFixtureCustody,
  assertAsyncLease,
  captureOwnedJSON,
  closeAsyncFile,
  openAsyncJournal,
  readAsyncAt,
  readAsyncStateUnderLease,
  writeAsyncStateUnderLease,
  type AsyncLease,
} from "./async-io.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const root = createFixtureRoot();
  const sessionId = "async-fixture";
  const directory = join(root, sessionId);
  mkdirSync(directory, { mode: 0o700 });
  const state: DecodedState = {
    state: {
      sessionId,
      startedAt: 123,
      cwd: "/fixture",
      stateRevision: 1,
      workspaceProfile: "profile-retained",
    } as SessionState,
  };
  writeFileSync(join(directory, "state.json"), encodeState(state));
  writeFileSync(join(directory, "output-journal.jsonl"), "fixture-header\n");
  return {
    root,
    sessionId,
    directory,
    state,
    target: join(directory, "state.json"),
    lock: join(directory, "state.json.lock"),
  };
}
async function exists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}
type Api = {
  stat(
    path: string,
    callback: (cause: NodeJS.ErrnoException | null, stat?: import("node:fs").Stats) => void,
  ): void;
  utimes(
    path: string,
    atime: Date,
    mtime: Date,
    callback: (cause: NodeJS.ErrnoException | null) => void,
  ): void;
  rmdirSync(path: string): void;
};
async function acquiredAdapter(f: ReturnType<typeof fixture>, hooks: FixtureIOHooks = {}) {
  expect(reservePath(f.target)).toBe(true);
  const adapter = new LeaseFs(f.target, (cause) => poisonPath(f.target, cause), hooks);
  const release = await lock(f.target, {
    realpath: false,
    retries: 0,
    stale: 10_000,
    update: 5_000,
    fs: adapter.api,
    onCompromised: (cause) => poisonPath(f.target, cause),
  });
  adapter.activate();
  return { adapter, api: adapter.api as Api, release };
}

describe("non-activated async fixture custody", () => {
  test("async lifetime refuses forged, nested and outlived tokens, retains metadata, dispose closes admission", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    expect(() =>
      assertAsyncLease({ root: f.root, sessionId: f.sessionId, directory: f.directory }),
    ).toThrow("native async");
    let token: AsyncLease | undefined;
    await custody.withLease(async (lease) => {
      token = lease;
      expect((await readAsyncStateUnderLease(lease)).state.workspaceProfile).toBe(
        "profile-retained",
      );
      await expect(custody.withLease(() => {})).rejects.toThrow("Nested");
      await delay(1);
      expect((await readAsyncStateUnderLease(lease)).state.sessionId).toBe(f.sessionId);
    });
    expect(() => assertAsyncLease(token!)).toThrow("native async");
    expect(await exists(f.lock)).toBe(false);
    await custody.dispose();
    await expect(custody.withLease(() => {})).rejects.toThrow("disposed");
  });

  test("falsy JavaScript thrown values remain failures and ordinary failure does not poison disposal", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    for (const value of [undefined, null, false, 0, ""]) {
      let rejected = false;
      let received: unknown = Symbol("unassigned");
      try {
        await custody.withLease(() => {
          throw value;
        });
      } catch (cause) {
        rejected = true;
        received = cause;
      }
      expect(rejected).toBe(true);
      expect(received).toBe(value);
    }
    await custody.withLease(() => {});
    await custody.dispose();
  });

  test("caller mutation of options cannot replace the captured cancellation signal", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    const original = new AbortController();
    const replacement = new AbortController();
    const options = { signal: original.signal };
    const ready = deferred();
    const finish = deferred();
    const work = custody.withLease(async () => {
      ready.resolve();
      await finish.promise;
    }, options);
    void work.catch(() => {});
    options.signal = replacement.signal;
    await ready.promise;
    original.abort();
    finish.resolve();
    await expect(work).rejects.toThrow("cancelled");
    await custody.dispose();
  });

  test("independent instances share nonblocking original 75ms path reservation through cleanup", async () => {
    const f = fixture();
    const first = await AsyncFixtureCustody.create(f.root, f.sessionId);
    const second = await AsyncFixtureCustody.create(f.root, f.sessionId);
    const ready = deferred();
    const finish = deferred();
    const held = first.withLease(async () => {
      ready.resolve();
      await finish.promise;
    });
    await ready.promise;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 2);
    const start = performance.now();
    await expect(second.withLease(() => {})).rejects.toThrow("75ms");
    clearInterval(timer);
    expect(performance.now() - start).toBeGreaterThanOrEqual(70);
    expect(ticks).toBeGreaterThan(5);
    finish.resolve();
    await held;
    await second.withLease(() => {});
    await Promise.all([first.dispose(), second.dispose()]);
  });

  test("strict owned JSON capture rejects scope accessor and Proxy before reads and detaches caller values", () => {
    let reads = 0;
    expect(() =>
      captureOwnedJSON({
        get kind() {
          reads++;
          return "control";
        },
      }),
    ).toThrow("Accessor");
    expect(() =>
      captureOwnedJSON(
        new Proxy(
          { kind: "control" },
          {
            get() {
              reads++;
              return "control";
            },
          },
        ),
      ),
    ).toThrow("Proxy");
    expect(reads).toBe(0);
    const input = { kind: "control", goal: { title: "before" }, array: [1, 2] };
    const owned = captureOwnedJSON(input);
    input.goal.title = "after";
    input.array[0] = 9;
    expect(owned.goal.title).toBe("before");
    expect(owned.array).toEqual([1, 2]);
    expect(Object.isFrozen(owned.goal)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(() => captureOwnedJSON(input, Infinity)).toThrow("capture byte bound");
    expect(() => captureOwnedJSON(input, 16 * 1024 * 1024 + 1)).toThrow("capture byte bound");
  });

  test("state and append bytes are captured before caller mutation and preserve raw metadata", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await custody.withLease(async (lease) => {
      const input = { state: { ...f.state.state, cwd: "/owned-before" } };
      const write = writeAsyncStateUnderLease(lease, input);
      input.state.cwd = "/caller-after";
      await write;
      const file = await openAsyncJournal(lease, true);
      const decorated = Buffer.from("x");
      Object.defineProperty(decorated, Symbol("decoration"), { value: "refused" });
      expect(() => appendAsyncUnderLease(lease, file, decorated, 15)).toThrow("Decorated");
      expect(() => readAsyncAt(lease, file, 2, JOURNAL_LIMIT - 1)).toThrow("Bounded async read");
      const bytes = Buffer.from("before\n");
      const append = appendAsyncUnderLease(
        lease,
        file,
        bytes,
        Buffer.byteLength("fixture-header\n"),
      );
      bytes.fill(0x78);
      await append;
      expect((await readAsyncAt(lease, file, 100, 0)).toString()).toBe("fixture-header\nbefore\n");
      await closeAsyncFile(lease, file);
    });
    const state = decodeStateBytes(readFileSync(f.target));
    expect(state.state.cwd).toBe("/owned-before");
    expect(state.state.workspaceProfile).toBe("profile-retained");
    await custody.dispose();
  });

  for (const shape of [
    "state-accessor",
    "format-accessor",
    "control-accessor",
    "proxy",
    "symbol",
  ]) {
    test(`real state-write entry rejects ${shape} without getter/trap reads or filesystem mutation`, async () => {
      const f = fixture();
      const before = readFileSync(f.target);
      const names = readdirSync(f.directory);
      let reads = 0;
      const inputState = { ...f.state.state, cwd: "/must-not-write" };
      const value: DecodedState = { state: inputState };
      let wrapper: DecodedState = value;
      if (shape.endsWith("-accessor")) {
        const key = shape.split("-")[0];
        Object.defineProperty(wrapper, key, {
          enumerable: true,
          get() {
            reads++;
            return key === "state" ? inputState : undefined;
          },
        });
      } else if (shape === "proxy") {
        wrapper = new Proxy(value, {
          get(target, key, receiver) {
            reads++;
            return Reflect.get(target, key, receiver);
          },
        });
      } else {
        Object.defineProperty(wrapper, Symbol("not-state-metadata"), { value: "refused" });
      }
      const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
      let rejected = false;
      try {
        await custody.withLease((lease) => writeAsyncStateUnderLease(lease, wrapper));
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(reads).toBe(0);
      expect(readFileSync(f.target)).toEqual(before);
      expect(readdirSync(f.directory)).toEqual(names);
      await custody.withLease(() => {});
      await custody.dispose();
    });
  }

  test("state wrapper capture preserves legitimate optional undefined fields", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    const state = {
      ...f.state.state,
      cwd: "/optional-retained",
      optionalFixtureValue: undefined,
    } as SessionState;
    await custody.withLease((lease) =>
      writeAsyncStateUnderLease(lease, { state, format: undefined, control: undefined }),
    );
    const restored = decodeStateBytes(readFileSync(f.target));
    expect(restored.state.cwd).toBe("/optional-retained");
    expect(Object.hasOwn(restored.state, "optionalFixtureValue")).toBe(false);
    expect(restored.state.workspaceProfile).toBe("profile-retained");
    await custody.dispose();
  });

  test("an own nonenumerable state wrapper field keeps its API argument value", async () => {
    const f = fixture();
    const wrapper = Object.defineProperty({}, "state", {
      value: { ...f.state.state, cwd: "/nonenumerable-owned-state" },
    }) as DecodedState;
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await custody.withLease((lease) => writeAsyncStateUnderLease(lease, wrapper));
    expect(decodeStateBytes(readFileSync(f.target)).state.cwd).toBe("/nonenumerable-owned-state");
    await custody.dispose();
  });

  for (const kind of ["state", "journal"]) {
    test(`cancellation immediately before the first ${kind} native write submits no bytes and remains reusable`, async () => {
      const f = fixture();
      const before = readFileSync(f.target);
      const journalPath = join(f.directory, "output-journal.jsonl");
      const journal = readFileSync(journalPath);
      const controller = new AbortController();
      let nativeWrites = 0;
      const custody = await AsyncFixtureCustody.create(f.root, f.sessionId, {
        observe: (event) => {
          if (event.operation === "file.write" && event.stage === "submit") controller.abort();
        },
        afterNative: (operation) => {
          if (operation === "file.write") nativeWrites++;
        },
      });
      await expect(
        custody.withLease(
          async (lease) => {
            if (kind === "state")
              await writeAsyncStateUnderLease(lease, {
                state: { ...f.state.state, cwd: "/must-not-write" },
              });
            else {
              const file = await openAsyncJournal(lease, true);
              await appendAsyncUnderLease(
                lease,
                file,
                Buffer.from("must-not-append\n"),
                journal.length,
              );
            }
          },
          { signal: controller.signal },
        ),
      ).rejects.toThrow("cancelled");
      expect(nativeWrites).toBe(0);
      expect(readFileSync(f.target)).toEqual(before);
      expect(readFileSync(journalPath)).toEqual(journal);
      expect(readdirSync(f.directory).some((name) => name.startsWith(".prototype-async"))).toBe(
        false,
      );
      await custody.withLease(() => {});
      await custody.dispose();
    });
  }

  test("cancellation waits for actual pending sync completion and required rename/directory sync", async () => {
    const f = fixture();
    const entered = deferred();
    const gate = deferred();
    const controller = new AbortController();
    const operations: string[] = [];
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId, {
      afterNative: async (operation) => {
        if (operation === "file.sync") {
          entered.resolve();
          await gate.promise;
        }
      },
      observe: (event) => {
        if (event.stage === "submit") operations.push(event.operation);
      },
    });
    let settled = false;
    const work = custody.withLease(
      (lease) =>
        writeAsyncStateUnderLease(lease, {
          state: { ...f.state.state, cwd: "/durably-completed" },
        }),
      { signal: controller.signal },
    );
    void work
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await entered.promise;
    controller.abort();
    await delay(20);
    expect(settled).toBe(false);
    expect(await exists(f.lock)).toBe(true);
    const another = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await expect(another.withLease(() => {})).rejects.toThrow("75ms");
    gate.resolve();
    await expect(work).rejects.toThrow("cancelled");
    expect(operations).toContain("state.rename");
    expect(operations).toContain("directory.sync");
    expect(decodeStateBytes(readFileSync(f.target)).state.cwd).toBe("/durably-completed");
    expect(await exists(f.lock)).toBe(false);
    await another.withLease(() => {});
    await Promise.all([custody.dispose(), another.dispose()]);
  });

  test("cancellation before the first submitted write leaves canonical state and journal unchanged", async () => {
    const f = fixture();
    const before = readFileSync(f.target);
    const journal = readFileSync(join(f.directory, "output-journal.jsonl"));
    const controller = new AbortController();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await expect(
      custody.withLease(
        async (lease) => {
          const writing = writeAsyncStateUnderLease(lease, {
            state: { ...f.state.state, cwd: "/must-not-write" },
          });
          controller.abort();
          await writing;
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled");
    expect(readFileSync(f.target)).toEqual(before);
    expect(readFileSync(join(f.directory, "output-journal.jsonl"))).toEqual(journal);
    expect(readdirSync(f.directory).some((name) => name.startsWith(".prototype-async"))).toBe(
      false,
    );
    await custody.dispose();
  });

  test("captured Session incarnation cannot change startedAt before a state mutation", async () => {
    const f = fixture();
    const before = readFileSync(f.target);
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await expect(
      custody.withLease((lease) =>
        writeAsyncStateUnderLease(lease, { state: { ...f.state.state, startedAt: 999 } }),
      ),
    ).rejects.toThrow("Captured Session identity");
    expect(readFileSync(f.target)).toEqual(before);
    expect(await exists(f.lock)).toBe(false);
    await custody.dispose();
  });

  test("forgotten await and dispose retain custody until submitted IO settles; no overlapping primitive", async () => {
    const f = fixture();
    const entered = deferred();
    const gate = deferred();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId, {
      afterNative: async (operation) => {
        if (operation === "file.sync") {
          entered.resolve();
          await gate.promise;
        }
      },
    });
    const work = custody.withLease((lease) => {
      void writeAsyncStateUnderLease(lease, f.state);
      expect(() => readAsyncStateUnderLease(lease)).toThrow("Overlapping");
    });
    await entered.promise;
    let disposed = false;
    const closing = custody.dispose().then(() => {
      disposed = true;
    });
    await delay(20);
    expect(disposed).toBe(false);
    expect(await exists(f.lock)).toBe(true);
    gate.resolve();
    await Promise.all([work, closing]);
    expect(disposed).toBe(true);
    expect(await exists(f.lock)).toBe(false);
  });

  test("known successor cannot be removed by original release and compromise is sticky across instances", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await expect(
      custody.withLease(async () => {
        await fsp.rename(f.lock, `${f.lock}.old`);
        await fsp.mkdir(f.lock);
      }),
    ).rejects.toThrow("incarnation");
    expect(await exists(f.lock)).toBe(true);
    await expect(custody.withLease(() => {})).rejects.toThrow("incarnation");
    await expect(AsyncFixtureCustody.create(f.root, f.sessionId)).rejects.toThrow("incarnation");
    await expect(custody.dispose()).rejects.toThrow("incarnation");
  });

  test("a replaced lock is checked before state mutation with unchanged Session incarnation", async () => {
    const f = fixture();
    const before = readFileSync(f.target);
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await expect(
      custody.withLease(async (lease) => {
        await fsp.rename(f.lock, `${f.lock}.old`);
        await fsp.mkdir(f.lock);
        await writeAsyncStateUnderLease(lease, {
          state: { ...f.state.state, cwd: "/must-not-write" },
        });
      }),
    ).rejects.toThrow("incarnation");
    expect(readFileSync(f.target)).toEqual(before);
    expect(await exists(f.lock)).toBe(true);
    await expect(custody.dispose()).rejects.toThrow("incarnation");
  });

  test("custody resumption after a pending sync checks the lock before canonical rename", async () => {
    const f = fixture();
    const before = readFileSync(f.target);
    const ready = deferred();
    const resume = deferred();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId, {
      afterNative: async (operation) => {
        if (operation === "file.sync") {
          ready.resolve();
          await resume.promise;
        }
      },
    });
    const work = custody.withLease((lease) =>
      writeAsyncStateUnderLease(lease, { state: { ...f.state.state, cwd: "/must-not-publish" } }),
    );
    void work.catch(() => {});
    await ready.promise;
    await fsp.rename(f.lock, `${f.lock}.old`);
    await fsp.mkdir(f.lock);
    resume.resolve();
    await expect(work).rejects.toThrow("incarnation");
    expect(readFileSync(f.target)).toEqual(before);
    expect(await exists(f.lock)).toBe(true);
    await expect(custody.dispose()).rejects.toThrow("incarnation");
  });

  test("primary operation and release failure remain separately inspectable", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    let failure: unknown;
    try {
      await custody.withLease(async () => {
        await fsp.rename(f.lock, `${f.lock}.old`);
        await fsp.mkdir(f.lock);
        throw new Error("primary operation failure");
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure instanceof AggregateError).toBe(true);
    expect(
      (failure as AggregateError).errors.some((cause) =>
        String(cause).includes("primary operation failure"),
      ),
    ).toBe(true);
    expect(
      (failure as AggregateError).errors.some((cause) => String(cause).includes("incarnation")),
    ).toBe(true);
    expect(String((failure as AggregateError).cause)).toContain("primary operation failure");
    expect(await exists(f.lock)).toBe(true);
    await expect(custody.dispose()).rejects.toThrow("incarnation");
  });

  test("dispose waiting for an active operation propagates its own release cleanup failure", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    const ready = deferred();
    const finish = deferred();
    const work = custody.withLease(async () => {
      ready.resolve();
      await finish.promise;
      await fsp.rename(f.lock, `${f.lock}.old`);
      await fsp.mkdir(f.lock);
      throw new Error("already reported primary");
    });
    void work.catch(() => {});
    await ready.promise;
    const disposal = custody.dispose();
    void disposal.catch(() => {});
    finish.resolve();
    await expect(work).rejects.toThrow("already reported primary");
    await expect(disposal).rejects.toThrow("incarnation");
    expect(await exists(f.lock)).toBe(true);
  });

  test("observed current-state incarnation loss stays sticky after caller catches and restores it", async () => {
    const f = fixture();
    const before = readFileSync(f.target);
    const journalPath = join(f.directory, "output-journal.jsonl");
    const journal = readFileSync(journalPath);
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await expect(
      custody.withLease(async (lease) => {
        await fsp.writeFile(f.target, encodeState({ state: { ...f.state.state, startedAt: 999 } }));
        await expect(custody.assertCurrent()).rejects.toThrow("authority revoked");
        await fsp.writeFile(f.target, before);
        const file = await openAsyncJournal(lease, true);
        await appendAsyncUnderLease(lease, file, Buffer.from("must-not-append\n"), journal.length);
      }),
    ).rejects.toThrow("authority revoked");
    expect(readFileSync(journalPath)).toEqual(journal);
    await expect(AsyncFixtureCustody.create(f.root, f.sessionId)).rejects.toThrow(
      "authority revoked",
    );
    await custody.dispose();
  });

  test("observed directory incarnation loss stays sticky across instances after the original name returns", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await expect(
      custody.withLease(async () => {
        await fsp.rename(f.directory, `${f.directory}.old`);
        await fsp.mkdir(f.directory);
        await expect(custody.assertDirectory()).rejects.toThrow("replaced/deleted");
        await fsp.rmdir(f.directory);
        await fsp.rename(`${f.directory}.old`, f.directory);
      }),
    ).rejects.toThrow("replaced/deleted");
    await expect(AsyncFixtureCustody.create(f.root, f.sessionId)).rejects.toThrow(
      "replaced/deleted",
    );
    expect(await exists(f.lock)).toBe(false);
    await custody.dispose();
  });

  test("append rechecks current state after an awaited callback before writing journal bytes", async () => {
    const f = fixture();
    const before = readFileSync(f.target);
    const journalPath = join(f.directory, "output-journal.jsonl");
    const journal = readFileSync(journalPath);
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await expect(
      custody.withLease(async (lease) => {
        const file = await openAsyncJournal(lease, true);
        await delay(1);
        await fsp.writeFile(f.target, encodeState({ state: { ...f.state.state, startedAt: 999 } }));
        await appendAsyncUnderLease(lease, file, Buffer.from("must-not-append\n"), journal.length);
      }),
    ).rejects.toThrow("authority revoked");
    expect(readFileSync(journalPath)).toEqual(journal);
    await fsp.writeFile(f.target, before);
    await expect(AsyncFixtureCustody.create(f.root, f.sessionId)).rejects.toThrow(
      "authority revoked",
    );
    await custody.dispose();
  });

  test("mutation IO failure poisons reuse without hiding cleanup failure or leaving a live lock", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId, {
      afterNative: (operation) => {
        if (operation === "file.sync")
          throw Object.assign(new Error("fixture EIO after native sync"), { code: "EIO" });
      },
    });
    await expect(
      custody.withLease((lease) => writeAsyncStateUnderLease(lease, f.state)),
    ).rejects.toThrow("fixture EIO");
    expect(await exists(f.lock)).toBe(false);
    await expect(custody.withLease(() => {})).rejects.toThrow("fixture EIO");
    expect(readdirSync(f.directory).some((name) => name.startsWith(".prototype-async"))).toBe(
      false,
    );
    await custody.dispose();
  });

  test("a secondary settle observer failure cannot replace the first storage failure", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId, {
      afterNative: (operation) => {
        if (operation === "file.sync") throw new Error("first storage failure");
      },
      observe: (event) => {
        if (event.operation === "file.sync" && event.stage === "settle")
          throw new Error("secondary observer failure");
      },
    });
    await expect(
      custody.withLease((lease) => writeAsyncStateUnderLease(lease, f.state)),
    ).rejects.toThrow("first storage failure");
    expect(await exists(f.lock)).toBe(false);
    await expect(custody.withLease(() => {})).rejects.toThrow("first storage failure");
    await custody.dispose();
  });

  test("bounded state constructor rejects oversized/symlink/invalid UTF8 and unsupported platform writes nothing", async () => {
    const f = fixture();
    truncateSync(f.target, 1024 * 1024 + 1);
    await expect(AsyncFixtureCustody.create(f.root, f.sessionId)).rejects.toThrow("byte bound");
    rmSync(f.target);
    writeFileSync(join(f.directory, "target-state"), encodeState(f.state));
    symlinkSync("target-state", f.target);
    await expect(AsyncFixtureCustody.create(f.root, f.sessionId)).rejects.toThrow();
    rmSync(f.target);
    writeFileSync(f.target, Buffer.from([0xff]));
    await expect(AsyncFixtureCustody.create(f.root, f.sessionId)).rejects.toThrow();
    writeFileSync(f.target, encodeState(f.state));
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    const before = readFileSync(f.target);
    await custody.withLease((lease) => {
      expect(() => writeAsyncStateUnderLease(lease, f.state, "win32")).toThrow("directory fsync");
    });
    expect(readFileSync(f.target)).toEqual(before);
    expect(readdirSync(f.directory).some((name) => name.startsWith(".prototype-async"))).toBe(
      false,
    );
    await custody.dispose();
  });

  test("primitive primary read failure retains an injected close failure and actual fallback close settles", async () => {
    const f = fixture();
    truncateSync(f.target, 1024 * 1024 + 1);
    let injection = 0;
    let fallback = 0;
    let failure: unknown;
    const hooks = {
      faultBefore: (operation: string) => {
        if (operation === "file.close") {
          injection++;
          return new Error("injected primitive close failure");
        }
      },
      observe: (event: { operation: string; stage: string }) => {
        if (event.operation === "file.close.fallback" && event.stage === "settle") fallback++;
      },
    } as FixtureIOHooks;
    try {
      await AsyncFixtureCustody.create(f.root, f.sessionId, hooks);
    } catch (cause) {
      failure = cause;
    }
    expect(failure instanceof AggregateError).toBe(true);
    expect(String((failure as AggregateError).cause)).toContain("byte bound");
    expect(
      (failure as AggregateError).errors.some((cause) =>
        String(cause).includes("primitive close failure"),
      ),
    ).toBe(true);
    expect(injection).toBeGreaterThan(0);
    expect(fallback).toBe(injection);
    expect(await exists(f.lock)).toBe(false);
  });

  test("primary storage and injected unlink cleanup failure both survive and dispose reports cleanup unknown", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId, {
      afterNative: (operation) => {
        if (operation === "file.sync") throw new Error("primary injected storage failure");
      },
      faultBefore: (operation) =>
        operation === "temp.unlink" ? new Error("injected unlink cleanup failure") : undefined,
    });
    let failure: unknown;
    try {
      await custody.withLease((lease) => writeAsyncStateUnderLease(lease, f.state));
    } catch (cause) {
      failure = cause;
    }
    expect(String(failure)).toContain("primary injected storage failure");
    expect(String(failure)).toContain("injected unlink cleanup failure");
    expect(failure instanceof AggregateError).toBe(true);
    expect(readdirSync(f.directory).some((name) => name.startsWith(".prototype-async"))).toBe(true);
    expect(await exists(f.lock)).toBe(false);
    await expect(custody.dispose()).rejects.toThrow("injected unlink cleanup failure");
  });

  test("capacity and replaced journal preflight do not append; deleted Session is not recreated", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await custody
      .withLease(async (lease) => {
        const file = await openAsyncJournal(lease, true);
        expect(() => appendAsyncUnderLease(lease, file, Buffer.from("x"), JOURNAL_LIMIT)).toThrow(
          "bound",
        );
        renameSync(join(f.directory, "output-journal.jsonl"), join(f.directory, "old-journal"));
        writeFileSync(join(f.directory, "output-journal.jsonl"), "successor");
        await expect(appendAsyncUnderLease(lease, file, Buffer.from("x"), 15)).rejects.toThrow(
          "incarnation",
        );
      })
      .catch((cause) => {
        expect(String(cause)).toContain("incarnation");
      });
    expect(readFileSync(join(f.directory, "old-journal"), "utf8")).toBe("fixture-header\n");
    await fsp.rm(f.directory, { recursive: true });
    await expect(custody.withLease(() => {})).rejects.toThrow();
    expect(await exists(f.directory)).toBe(false);
    await custody.dispose();
  });

  test("an oversized physical journal is rejected without allocating or rewriting its content", async () => {
    const f = fixture();
    const path = join(f.directory, "output-journal.jsonl");
    truncateSync(path, JOURNAL_LIMIT + 1);
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    await expect(custody.withLease((lease) => openAsyncJournal(lease))).rejects.toThrow(
      "Journal storage bound",
    );
    expect((await fsp.stat(path)).size).toBe(JOURNAL_LIMIT + 1);
    expect(await exists(f.lock)).toBe(false);
    await custody.dispose();
  });
});

describe("public callback lease adapter lifecycle", () => {
  for (const operation of ["lock.mkdir", "lock.utimes"]) {
    for (const value of [undefined, null, false, 0, ""]) {
      test(`${operation} rejection ${String(value)} stays a failure through Node callbacks and settled cleanup`, async () => {
        const f = fixture();
        const seen: unknown[] = [];
        const adapter = new LeaseFs(
          f.target,
          (cause) => {
            seen.push(cause);
            poisonPath(f.target, cause);
          },
          {
            afterNative: (name) => {
              if (name === operation) throw value;
            },
          },
        );
        expect(reservePath(f.target)).toBe(true);
        let release: (() => Promise<void>) | undefined;
        let granted = false;
        let received: unknown;
        try {
          release = await lock(f.target, { realpath: false, retries: 0, fs: adapter.api });
          adapter.activate();
          granted = true;
        } catch (cause) {
          received = cause;
        }
        let cleanupRejected = false;
        let cleanupCause: unknown;
        try {
          await adapter.close(release);
        } catch (cause) {
          cleanupRejected = true;
          cleanupCause = cause;
        } finally {
          releasePath(f.target);
        }
        expect(granted).toBe(false);
        expect(received instanceof Error).toBe(true);
        expect((received as Error).cause).toBe(value);
        expect(cleanupRejected).toBe(true);
        expect(cleanupCause).toBe(value);
        expect(seen).toContain(value);
        expect(adapter.snapshot()).toEqual({
          phase: "closed",
          pending: 0,
          descriptorOpen: false,
          created: false,
        });
        expect(await exists(f.lock)).toBe(false);
        let refused = false;
        let sticky: unknown;
        try {
          await AsyncFixtureCustody.create(f.root, f.sessionId);
        } catch (cause) {
          refused = true;
          sticky = cause;
        }
        expect(refused).toBe(true);
        expect(sticky).toBe(value);
      });
    }
  }
  test("precision Symbol cache stays extensible, normal release closes descriptor and callbacks", async () => {
    const f = fixture();
    const { adapter, release } = await acquiredAdapter(f);
    expect(Object.getOwnPropertySymbols(adapter.api).length).toBeGreaterThan(0);
    await adapter.close(release);
    releasePath(f.target);
    expect(adapter.snapshot()).toEqual({
      phase: "closed",
      pending: 0,
      descriptorOpen: false,
      created: false,
    });
    expect(await exists(f.lock)).toBe(false);
  });

  test("mkdir success before descriptor/grant failure cleans its proven incarnation without release handle", async () => {
    const f = fixture();
    const adapter = new LeaseFs(f.target, (cause) => poisonPath(f.target, cause), {
      afterNative: (operation) => {
        if (operation === "lock.mkdir.created")
          throw new Error("fixture descriptor acquisition failed");
      },
    });
    expect(reservePath(f.target)).toBe(true);
    await expect(lock(f.target, { realpath: false, retries: 0, fs: adapter.api })).rejects.toThrow(
      "descriptor acquisition",
    );
    expect(adapter.snapshot().created).toBe(true);
    await adapter.close();
    releasePath(f.target);
    expect(adapter.snapshot()).toEqual({
      phase: "closed",
      pending: 0,
      descriptorOpen: false,
      created: false,
    });
    expect(await exists(f.lock)).toBe(false);
  });

  test("precision probe failure drains its rmdir descendant before closing a grantless adapter", async () => {
    const f = fixture();
    const adapter = new LeaseFs(f.target, (cause) => poisonPath(f.target, cause), {
      afterNative: (operation) => {
        if (operation === "lock.utimes") throw new Error("fixture precision probe failed");
      },
    });
    expect(reservePath(f.target)).toBe(true);
    await expect(lock(f.target, { realpath: false, retries: 0, fs: adapter.api })).rejects.toThrow(
      "precision probe",
    );
    await adapter.close();
    releasePath(f.target);
    expect(adapter.snapshot().pending).toBe(0);
    expect(adapter.snapshot().descriptorOpen).toBe(false);
    expect(await exists(f.lock)).toBe(false);
  });

  test("pending stat callback descendants settle before original release and do not update a successor", async () => {
    const f = fixture();
    const entered = deferred();
    const gate = deferred();
    let hold = false;
    const { adapter, api, release } = await acquiredAdapter(f, {
      afterNative: async (operation) => {
        if (hold && operation === "lock.stat") {
          entered.resolve();
          await gate.promise;
        }
      },
    });
    hold = true;
    const descendant = new Promise<void>((resolve, reject) =>
      api.stat(f.lock, (cause) => {
        if (cause) {
          reject(cause);
          return;
        }
        api.utimes(f.lock, new Date(), new Date(), (failure) =>
          failure ? reject(failure) : resolve(),
        );
      }),
    );
    void descendant.catch(() => {});
    await entered.promise;
    const closing = adapter.close(release);
    void closing.catch(() => {});
    await fsp.rename(f.lock, `${f.lock}.previous`);
    await fsp.mkdir(f.lock);
    const before = await fsp.stat(f.lock);
    expect(adapter.snapshot().descriptorOpen).toBe(true);
    expect(() => api.rmdirSync(f.lock)).toThrow("exit hook");
    gate.resolve();
    await expect(descendant).rejects.toThrow("incarnation");
    await expect(closing).rejects.toThrow("incarnation");
    releasePath(f.target);
    const after = await fsp.stat(f.lock);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(adapter.snapshot().pending).toBe(0);
    expect(adapter.snapshot().descriptorOpen).toBe(false);
    const later = new Date(before.mtimeMs + 1000);
    await new Promise<void>((resolve) =>
      api.utimes(f.lock, later, later, (cause) => {
        expect(cause?.code).toBe("EBUSY");
        resolve();
      }),
    );
    expect((await fsp.stat(f.lock)).mtimeMs).toBe(before.mtimeMs);
  });

  test("pending descriptor utimes completion drains before descriptor close and original unlock", async () => {
    const f = fixture();
    const entered = deferred();
    const gate = deferred();
    let hold = false;
    const { adapter, api, release } = await acquiredAdapter(f, {
      afterNative: async (operation) => {
        if (hold && operation === "lock.utimes") {
          entered.resolve();
          await gate.promise;
        }
      },
    });
    hold = true;
    const update = new Promise<void>((resolve, reject) =>
      api.utimes(f.lock, new Date(), new Date(), (cause) => (cause ? reject(cause) : resolve())),
    );
    await entered.promise;
    let closed = false;
    const closing = adapter.close(release).then(() => {
      closed = true;
    });
    await delay(20);
    expect(closed).toBe(false);
    expect(adapter.snapshot().descriptorOpen).toBe(true);
    expect(adapter.snapshot().pending).toBe(1);
    gate.resolve();
    await Promise.all([update, closing]);
    releasePath(f.target);
    expect(adapter.snapshot()).toEqual({
      phase: "closed",
      pending: 0,
      descriptorOpen: false,
      created: false,
    });
  });

  test("actual heartbeat stat and utimes remain alive across an awaited holder", async () => {
    const f = fixture();
    let stats = 0;
    let updates = 0;
    const heartbeat = deferred();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId, {
      afterNative: (operation) => {
        if (operation === "lock.stat") stats++;
        if (operation === "lock.utimes" && ++updates >= 2) heartbeat.resolve();
      },
    });
    await custody.withLease(async () => {
      await heartbeat.promise;
    });
    expect(stats).toBeGreaterThanOrEqual(2);
    expect(updates).toBeGreaterThanOrEqual(2);
    expect(await exists(f.lock)).toBe(false);
    await custody.dispose();
  });
});
