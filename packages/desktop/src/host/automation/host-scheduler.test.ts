import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { CronStore } from "@cjhyy/code-shell-core/internal";
import { HostScheduler } from "./host-scheduler.js";
import { CronPeer, nodeCronPort } from "./peer.js";
import { attachCronStorage } from "./storage-owner.js";

const engines = {
  run: async () => {
    throw Error("No scheduled run expected");
  },
};
const permit = () => new Int32Array(new SharedArrayBuffer(4));

test("commands before native binding await the loaded store and keep their originating document grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "cron-cold-start-"));
  const file = join(root, "cron.json");
  const store = new CronStore(file);
  const storageChannel = new MessageChannel();
  const owner = attachCronStorage(storageChannel.port2, file);
  const scheduler = new HostScheduler(storageChannel.port1, engines);
  const nativeChannel = new MessageChannel();
  const native = new CronPeer(nodeCronPort(nativeChannel.port2), () => true);
  try {
    store.save([
      {
        id: "seed",
        name: "seed",
        enabled: false,
        schedule: "1h",
        prompt: "seed",
        runCount: 0,
        createdAt: 1,
      },
    ]);
    const live = new AbortController();
    const read = scheduler.command({ method: "list", input: undefined }, permit(), live.signal);
    const create = (name: string, signal: AbortSignal) =>
      scheduler.command(
        {
          method: "create",
          input: { name, schedule: "1h", prompt: name },
        },
        permit(),
        signal,
      );
    const added = create("first command", live.signal);
    const revoked = new AbortController();
    const abandoned = create("abandoned", revoked.signal);
    revoked.abort(Error("Document navigated"));
    await expect(abandoned).rejects.toThrow("Document navigated");
    scheduler.bind(nodeCronPort(nativeChannel.port1), "");
    expect(await read).toContainEqual(expect.objectContaining({ id: "seed" }));
    expect(await added).toMatchObject({ name: "first command" });
    expect(
      store
        .load()
        .map((item) => item.name)
        .sort(),
    ).toEqual(["first command", "seed"]);
  } finally {
    await scheduler.close();
    native.close();
    owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closing an unbound Host releases a waiting workbench", async () => {
  const channel = new MessageChannel();
  const scheduler = new HostScheduler(channel.port1, engines);
  try {
    const read = scheduler.command(
      { method: "list", input: undefined },
      permit(),
      new AbortController().signal,
    );
    const closed = scheduler.close();
    await expect(read).rejects.toThrow("scheduler is closed");
    await closed;
  } finally {
    channel.port2.close();
  }
});
