import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { NativeMimiTasks } from "../../main/desktop-host/mimi-task-client.js";
import { nodePrivatePort } from "../native-peer.js";
import { HostBusinessCalls } from "./business-calls.js";
import { HostedMimiTasks } from "./mimi-tasks.js";
import { PetLongTaskStore } from "../../main/pet/pet-long-task-store.js";

test("only the Host owns the committed task ledger and a withdrawn native control cannot cancel a task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mimi-host-ledger-"));
  const file = join(directory, "long-tasks.json");
  const seed = new PetLongTaskStore(file);
  await seed.create({
    id: "test-task",
    sessionId: "test-session",
    objective: "Await a decision",
    originClientMessageId: "seed",
    at: 5,
    workspacePath: null,
  });
  await seed.transition("test-task", { kind: "started", at: 6 });
  await seed.transition("test-task", { kind: "interrupted", at: 7, reason: "offline" });
  const host = new HostedMimiTasks(directory);
  const commands = new HostBusinessCalls({ "mimi/tasks": (cmd, grant) => host.run(cmd, grant) });
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<boolean>();
  let seq = 0;
  const native = new NativeMimiTasks(
    async (cmd, signal) => {
      const id = String(++seq);
      const abort = () => commands.revoke(id);
      signal?.throwIfAborted();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return await commands.run(id, "mimi/tasks", cmd);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    () => {
      const { port1, port2 } = new MessageChannel();
      host.bind(nodePrivatePort(port1));
      native.bind(nodePrivatePort(port2));
    },
  );
  native.configure({
    launcher: {
      start: async () => {
        throw Error("No launch expected");
      },
    },
    projection: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        workerState: "active",
        sessions: [],
        pending: [],
        observedAt: 10,
        workMemorySegments: [],
      }),
      subscribe: () => () => {},
    },
    worker: {
      hasLiveWorker: () => {
        entered.resolve();
        return released.promise;
      },
      requestWorker: async () => {
        throw Error("No worker control expected");
      },
    },
  });
  try {
    expect(await native.get("test-task")).toMatchObject({ status: "interrupted" });
    await native.start();
    const grant = new AbortController();
    const control = native.control({ taskId: "test-task", action: "cancel" }, grant.signal);
    await entered.promise;
    grant.abort();
    released.resolve(false);
    await expect(control).rejects.toThrow();
    expect(await native.activeForSession("test-session")).toMatchObject({ status: "interrupted" });
    expect(JSON.parse(await readFile(file, "utf8")).tasks[0].status).toBe("interrupted");
    expect(await native.control({ taskId: "test-task", action: "pause" })).toMatchObject({
      ok: true,
      task: { status: "paused" },
    });
    expect((await host.snapshot()).tasks[0]?.status).toBe("paused");
  } finally {
    released.resolve(false);
    native.stop();
    commands.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
