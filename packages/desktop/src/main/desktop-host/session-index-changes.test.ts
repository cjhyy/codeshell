import { expect, test } from "bun:test";
import { channel } from "node:diagnostics_channel";
import {
  createSessionIndexChanges,
  consumeSessionIndexNotification,
} from "./session-index-changes";
import { DesktopSessionListVisibility } from "./session-list-visibility";
import type { ListDiskSessionsResult } from "@cjhyy/code-shell-server/storage";

test("committed states and private worker notifications update only the fixed root in bounded batches", () => {
  const batches: string[][] = [];
  const watcher = createSessionIndexChanges("/owned/sessions", (ids) => batches.push(ids));
  try {
    const writes = channel("codeshell.session.state-committed");
    writes.publish({ root: "/other/sessions", id: "ignored" });
    for (let i = 0; i < 300; i++) writes.publish({ root: "/owned/sessions", id: `id-${i}` });
    writes.publish({ root: "/owned/sessions", id: "id-0" });
    expect(
      consumeSessionIndexNotification(
        {
          jsonrpc: "2.0",
          method: "host/sessionIndexChanged",
          params: { ids: ["id-0", "worker", "not/a/session"] },
        },
        watcher.add,
      ),
    ).toBe(true);
    expect(
      consumeSessionIndexNotification(
        {
          jsonrpc: "2.0",
          id: "ordinary",
          method: "host/sessionIndexChanged",
          params: { ids: ["not-a-notification"] },
        },
        watcher.add,
      ),
    ).toBe(true);
    expect(consumeSessionIndexNotification({ method: "agent/status" }, watcher.add)).toBe(false);
    watcher.flush();
    expect(batches.map((ids) => ids.length)).toEqual([256, 45]);
    expect(batches.flat()).toEqual([...Array.from({ length: 300 }, (_, i) => `id-${i}`), "worker"]);
  } finally {
    watcher.close();
  }
});

test("only the deleted row is hidden from both existing and fresh WAL snapshots", async () => {
  let settle!: (value: ListDiskSessionsResult) => void;
  let cleaned!: () => void;
  const page: ListDiskSessionsResult = {
    sessions: ["a", "b"].map((id) => ({
      id,
      engineSessionId: id,
      cwd: "/work",
      title: id,
      updatedAt: 1,
      origin: "desktop",
    })),
    nextCursor: null,
  };
  let delay = true;
  const catalog = new DesktopSessionListVisibility({
    list: async () =>
      delay
        ? new Promise<ListDiskSessionsResult>((resolve) => {
            settle = resolve;
          })
        : page,
    changed: async () =>
      new Promise<void>((resolve) => {
        cleaned = resolve;
      }),
  });
  const old = catalog.list({ limit: 10 });
  catalog.setDeleting("a", true);
  catalog.setDeleting("a", false);
  delay = false;
  expect((await catalog.list({ limit: 10 })).sessions.map((row) => row.id)).toEqual(["b"]);
  cleaned();
  await new Promise<void>((resolve) => setImmediate(resolve));
  settle(page);
  expect((await old).sessions.map((row) => row.id)).toEqual(["b"]);
  expect((await catalog.list({ limit: 10 })).sessions.map((row) => row.id)).toEqual(["a", "b"]);
});
