import { afterEach, expect, test } from "bun:test";
import type {
  MobileClientEvent,
  MobileServerEvent,
  MobileHistoryView,
} from "@cjhyy/code-shell-core";
import { MobileOutputClient } from "./mobileOutputClient.js";
const clients: MobileOutputClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.cancel(false);
});
const cursor = (sequence: number) =>
  Buffer.from(
    JSON.stringify({
      identity: "a".repeat(64),
      hash: "b".repeat(64),
      sequence,
      offset: 100 + sequence * 10,
    }),
  ).toString("base64url");
function fixture() {
  const sent: MobileClientEvent[] = [],
    commits: any[] = [],
    prepends: any[] = [],
    windows: any[] = [];
  let failures = 0,
    suppress = false;
  let late: MobileServerEvent | undefined;
  let revision = 1,
    generation = 0;
  const detail = JSON.stringify({ result: "x".repeat(1_100_000), args: { path: "fixture" } });
  const view = (earlier: boolean): MobileHistoryView => ({
    status: "ok",
    viewId: `view-${generation}`,
    through: cursor(30),
    coverageStart: cursor(0),
    coverageIdentity: "incarnation",
    verifiedInputIds: ["old-user", "new-user"],
    snapshot: {
      epoch: "main",
      nextSeq: 30,
      outputCursor: cursor(30),
      unpaired: false,
      incarnation: "incarnation",
      journalIdentity: "b".repeat(64),
    },
    state: { sessionId: "s", run: "completed", seq: 30, liveByAgent: {} },
    totalItems: 4,
    ...(earlier
      ? {
          start: 0,
          end: 2,
          items: [
            { kind: "user", id: "old", text: "old", clientMessageId: "old-user" },
            { kind: "user", id: "new", text: "new", clientMessageId: "new-user" },
          ],
        }
      : {
          start: 2,
          end: 4,
          before: "earlier",
          items: [
            { kind: "assistant", id: "answer", text: "answer", reasoning: "", done: true },
            {
              kind: "tool",
              id: "tool",
              name: "Read",
              done: true,
              detailRef: `detail-${generation}`,
            },
          ],
        }),
  });
  let transform: ((reply: MobileServerEvent) => MobileServerEvent) | undefined;
  const client = new MobileOutputClient({
    current: () => ({ sessionId: "s", revision }),
    send: (event) => {
      sent.push(event);
      queueMicrotask(() => {
        let reply: MobileServerEvent | undefined;
        if (event.type === "session.select" && event.recoveryId) {
          generation++;
          reply = {
            type: "session.recovery.ready",
            sessionId: "s",
            recoveryId: event.recoveryId,
            ok: true,
            journalRequired: true,
          };
        }
        if (event.type === "session.historyView")
          reply = { ...event, result: view(!!event.before) };
        if (event.type === "session.historyDetail") {
          const index = event.cursor ? Number(event.cursor) : 0,
            end = Math.min(index + 256 * 1024, detail.length);
          reply = {
            ...event,
            result: {
              status: "ok",
              ref: event.ref,
              index,
              data: Buffer.from(detail.slice(index, end)).toString("base64"),
              totalBytes: detail.length,
              ...(end === detail.length
                ? { complete: true }
                : { complete: false, next: String(end) }),
            },
          };
        }
        if (reply) {
          reply = transform?.(reply) ?? reply;
          if (suppress) late = reply;
          else client.observe(reply);
        }
      });
      return true;
    },
    commit: (_id, result) => commits.push(result),
    prependHistory: (_id, items) => prepends.push(items),
    historyWindow: (_id, value) => windows.push(value),
    failed: () => failures++,
    legacy: () => {
      throw new Error("unexpected legacy fallback");
    },
  });
  clients.push(client);
  client.observe({
    type: "auth.ok",
    device: { id: "device", name: "fixture" },
    capabilities: { outputJournal: 1, historyView: 1 },
  });
  return {
    client,
    sent,
    commits,
    prepends,
    windows,
    failures: () => failures,
    suppress: () => {
      suppress = true;
    },
    release: () => {
      suppress = false;
      if (late) client.observe(late);
    },
    changeSelection: () => {
      revision++;
      client.cancel();
    },
    transform: (fn: typeof transform) => {
      transform = fn;
    },
  };
}
async function settle(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    await Promise.resolve();
    if (check()) return;
  }
  throw new Error("fixture did not settle");
}
test("initial tail sends no tool body or journal request; earlier and big detail load only on demand", async () => {
  const f = fixture();
  f.client.begin("s");
  await settle(() => f.commits.length === 1);
  expect(f.commits[0].chat.items).toHaveLength(2);
  expect(JSON.stringify(f.commits[0]).length).toBeLessThan(4096);
  expect(f.sent.map((event) => event.type)).toEqual(["session.select", "session.historyView"]);
  await f.client.loadEarlier();
  expect(f.prepends[0].map((item: any) => item.id)).toEqual(["old", "new"]);
  expect(f.windows.at(-1)).toMatchObject({ hasEarlier: false });
  expect(f.commits).toHaveLength(1);
  const detail = await f.client.loadDetail("detail-1");
  expect(detail.result).toHaveLength(1_100_000);
  expect(f.sent.filter((event) => event.type === "session.historyDetail")).toHaveLength(5);
  expect(
    f.sent.some((event) =>
      ["chat.send", "approval.respond", "session.outputJournal"].includes(event.type),
    ),
  ).toBe(false);
});
test("a late detail or earlier reply cannot mutate a replaced selection", async () => {
  for (const kind of ["detail", "earlier"]) {
    const f = fixture();
    f.client.begin("s");
    await settle(() => f.commits.length === 1);
    f.suppress();
    const request = kind === "detail" ? f.client.loadDetail("detail-1") : f.client.loadEarlier();
    const rejection = request.then(
      () => undefined,
      (error) => error,
    );
    await Promise.resolve();
    f.changeSelection();
    f.release();
    expect(await rejection).toBeInstanceOf(Error);
    expect(f.commits).toHaveLength(1);
    expect(f.prepends).toHaveLength(0);
    expect(f.failures()).toBe(0);
  }
});
test("unpaired view fails closed and expired detail requires explicit reload instead of automatic writes", async () => {
  const bad = fixture();
  bad.transform((event) =>
    event.type === "session.historyView" && event.result.status === "ok"
      ? {
          ...event,
          result: { ...event.result, snapshot: { ...event.result.snapshot, unpaired: true } },
        }
      : event,
  );
  bad.client.begin("s");
  await settle(() => bad.failures() === 1);
  expect(bad.commits).toHaveLength(0);
  const f = fixture();
  f.client.begin("s");
  await settle(() => f.commits.length === 1);
  f.transform((event) =>
    event.type === "session.historyDetail" ? { ...event, result: { status: "incomplete" } } : event,
  );
  await expect(f.client.loadDetail("detail-1")).rejects.toThrow();
  expect(f.sent.filter((event) => event.type === "session.historyDetail")).toHaveLength(1);
  f.transform(undefined);
  f.client.begin("s");
  await settle(() => f.commits.length === 2);
  await expect(f.client.loadDetail("detail-1")).rejects.toThrow();
  expect((await f.client.loadDetail("detail-2")).result).toHaveLength(1_100_000);
  expect(f.sent.some((event) => event.type === "chat.send")).toBe(false);
});
test("new live output touching a deferred tool retires the old view before it can overwrite the card", async () => {
  const f = fixture();
  f.client.begin("s");
  await settle(() => f.commits.length === 1);
  f.suppress();
  expect(
    f.client.hold("s", {
      type: "tool_result",
      result: { id: "tool", result: "updated" },
      outputCursor: cursor(31),
    }),
  ).toBe("pending");
  await expect(f.client.loadDetail("detail-1")).rejects.toThrow();
  expect(f.sent.filter((event) => event.type === "session.select")).toHaveLength(2);
  expect(f.sent.some((event) => event.type === "chat.send")).toBe(false);
});

test("an overlapping earlier page cannot duplicate rows or replace current control state", async () => {
  const f = fixture();
  f.client.begin("s");
  await settle(() => f.commits.length === 1);
  f.transform((event) =>
    event.type === "session.historyView" && event.result.status === "ok"
      ? {
          ...event,
          result: {
            ...event.result,
            items: [
              { kind: "user", id: "answer", text: "wrong" },
              { kind: "user", id: "other", text: "wrong" },
            ],
          },
        }
      : event,
  );
  await expect(f.client.loadEarlier()).rejects.toThrow();
  expect(f.prepends).toHaveLength(0);
  expect(f.commits).toHaveLength(1);
});
