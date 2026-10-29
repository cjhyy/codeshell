import { expect, test } from "bun:test";
import {
  HistoryReadBusyError,
  HistoryReadCancelledError,
  MobileHistoryReadQueue,
} from "./mobileHistoryReadQueue.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => value,
    (error) => error,
  );

test("two expanded details serialize their complete multipart reads in FIFO order", async () => {
  const queue = new MobileHistoryReadQueue();
  const firstPart = gate();
  const calls: string[] = [];
  const first = queue.run("view", async () => {
    calls.push("first-part");
    await firstPart.promise;
    calls.push("first-complete");
    return "first";
  });
  const second = queue.run("view", async () => {
    calls.push("second");
    return "second";
  });
  await Promise.resolve();
  expect(calls).toEqual(["first-part"]);
  firstPart.resolve();
  expect(await Promise.all([first, second])).toEqual(["first", "second"]);
  expect(calls).toEqual(["first-part", "first-complete", "second"]);
});

test("a rejected or synchronously throwing read does not strand the next operation", async () => {
  const queue = new MobileHistoryReadQueue();
  const first = outcome(
    queue.run("view", () => {
      throw new Error("owned failure");
    }),
  );
  const second = queue.run("view", async () => "recovered");
  expect(await first).toBeInstanceOf(Error);
  expect(await second).toBe("recovered");
});

test("reset retires queued work; a late active completion cannot drain the replacement view", async () => {
  const queue = new MobileHistoryReadQueue();
  const oldActive = gate(),
    newActive = gate();
  const calls: string[] = [];
  const first = queue.run("old", () => oldActive.promise);
  const retired = outcome(
    queue.run("old", async () => {
      calls.push("retired");
    }),
  );
  await Promise.resolve();
  queue.reset();
  expect(await retired).toBeInstanceOf(HistoryReadCancelledError);
  const next = queue.run("new", () => newActive.promise);
  const following = queue.run("new", async () => {
    calls.push("new-following");
  });
  oldActive.resolve();
  await first;
  expect(calls).toEqual([]);
  newActive.resolve();
  await Promise.all([next, following]);
  expect(calls).toEqual(["new-following"]);
});

test("a new key also retires old work before its scheduled callback can begin", async () => {
  const queue = new MobileHistoryReadQueue();
  const calls: string[] = [];
  const stale = outcome(
    queue.run("old", async () => {
      calls.push("old");
    }),
  );
  const queued = outcome(
    queue.run("old", async () => {
      calls.push("old-queued");
    }),
  );
  await queue.run("new", async () => {
    calls.push("new");
  });
  expect(await stale).toBeInstanceOf(HistoryReadCancelledError);
  expect(await queued).toBeInstanceOf(HistoryReadCancelledError);
  expect(calls).toEqual(["new"]);
});

test("only eight waiting operations are admitted and overflow never invokes work", async () => {
  const queue = new MobileHistoryReadQueue();
  const active = gate();
  const first = queue.run("view", () => active.promise);
  const calls: number[] = [];
  const waiting = Array.from({ length: 8 }, (_, index) =>
    queue.run("view", async () => {
      calls.push(index);
    }),
  );
  const overflow = await outcome(
    queue.run("view", async () => {
      calls.push(99);
    }),
  );
  expect(overflow).toBeInstanceOf(HistoryReadBusyError);
  active.resolve();
  await Promise.all([first, ...waiting]);
  expect(calls).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test("a waiting read times out without cancelling the active read or running later", async () => {
  const queue = new MobileHistoryReadQueue(5);
  const active = gate();
  const first = queue.run("view", () => active.promise);
  let expiredRan = false;
  const expired = await outcome(
    queue.run("view", async () => {
      expiredRan = true;
    }),
  );
  expect(expired).toBeInstanceOf(HistoryReadBusyError);
  active.resolve();
  await first;
  expect(await queue.run("view", async () => "next")).toBe("next");
  expect(expiredRan).toBe(false);
});
