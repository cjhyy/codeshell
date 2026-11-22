import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MimiRouteCall } from "../../shared/mimi-conversation-routes.js";
import { StoredMimiConversationRoutes } from "./mimi-conversation-routes.js";

test("the Host owns one binding per private conversation across changes, revoked writes and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mimi-conversation-route-owner-"));
  const permit = () => new Int32Array(new SharedArrayBuffer(4));
  const run = (owner: StoredMimiConversationRoutes, call: MimiRouteCall, word = permit()) =>
    owner.run({ call, permit: word });
  try {
    const owner = new StoredMimiConversationRoutes(dir);
    const entry = {
      routeKey: "im:fixture\0chat\0sender",
      channel: "fixture",
      target: "chat",
      senderId: "sender",
      sessionId: "s1",
      sessionTitle: "one",
      mode: "bound",
      origin: "enter",
    } as const;
    await run(owner, { method: "upsert", args: [entry] });
    const revoked = permit();
    Atomics.store(revoked, 0, -1);
    await expect(
      run(owner, { method: "leave", args: [entry.routeKey, "user"] }, revoked),
    ).rejects.toThrow("expired");
    expect(await run(owner, { method: "boundRoute", args: [entry.routeKey] })).toMatchObject({
      value: { sessionId: "s1" },
    });
    await run(owner, {
      method: "upsert",
      args: [{ ...entry, sessionId: "s2", sessionTitle: "two" }],
    });
    const next = new StoredMimiConversationRoutes(dir);
    expect(await run(next, { method: "boundRoute", args: [entry.routeKey] })).toMatchObject({
      value: { sessionId: "s2" },
    });
    expect(await run(next, { method: "notifyRoutesForSession", args: ["s1"] })).toMatchObject({
      value: [{ sessionId: "s1", mode: "notify" }],
    });
    await run(next, { method: "leave", args: [entry.routeKey, "user"] });
    expect(await run(next, { method: "boundRoute", args: [entry.routeKey] })).toEqual({
      value: undefined,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
