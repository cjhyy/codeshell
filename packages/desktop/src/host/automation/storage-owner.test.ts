import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { CronStore, type CronJob } from "@cjhyy/code-shell-core/internal";
import { attachCronStorage } from "./storage-owner.js";
import { CronPeer, nodeCronPort } from "./peer.js";
import { CronExecutionReceipts, type CronNotice } from "./execution-receipts.js";

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Scheduler fixture timed out");
}
const job: CronJob = {
  id: "fixture",
  name: "Synthetic",
  schedule: "1h",
  prompt: "fixture",
  createdAt: 1,
  runCount: 0,
  enabled: true,
};
test("storage owns the scheduler, abort waits for Engine cleanup, and notices have stable identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cron-storage-"));
  const file = join(dir, "cron.json");
  const port = new MessageChannel();
  const receiptWait = Promise.withResolvers<void>();
  const run = Promise.withResolvers<void>();
  let gotRun = false,
    aborted = false;
  const notices: CronNotice[] = [];
  const storage = attachCronStorage(port.port2, file);
  const host = new CronPeer(nodeCronPort(port.port1), async (method, input, signal) => {
    if (method === "execute") {
      gotRun = true;
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      await run.promise;
      return { text: "", reason: "cancelled" };
    }
    if (method === "deliver") {
      notices.push(input as CronNotice);
      await receiptWait.promise;
    }
  });
  const permit = new Int32Array(new SharedArrayBuffer(4));
  try {
    new CronStore(file).save([job]);
    await host.call("start", undefined);
    expect(
      await host.call("command", { cmd: { method: "runNow", input: "fixture" }, permit }),
    ).toBe(true);
    await waitFor(() => gotRun);
    let settled = false;
    const cancelling = host
      .call("command", { cmd: { method: "cancel", input: "fixture" }, permit })
      .then((result) => {
        settled = true;
        return result;
      });
    await waitFor(() => aborted);
    expect(settled).toBe(false);
    run.resolve();
    expect(await cancelling).toBe(true);
    await waitFor(() => notices.length === 1);
    expect(notices[0]).toMatchObject({
      type: "job_cancelled",
      job: { id: "fixture", runCount: 1 },
    });
    receiptWait.resolve();
  } finally {
    run.resolve();
    receiptWait.resolve();
    await host.call("stop", undefined);
    host.close();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("recover a claimed one-shot without rerunning it, retry completed delivery, and leave a replacement alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cron-durable-"));
  try {
    const store = new CronStore(join(dir, "cron.json"));
    const path = join(dir, "receipts.json");
    const recurring = { ...job, id: "repeat" };
    const done = { ...job, id: "done", once: true, runCount: 1 };
    const uncertain = { ...job, once: true, runCount: 1 };
    store.save([recurring, done, uncertain]);
    let receipts = new CronExecutionReceipts(path, store);
    receipts.claim(recurring);
    const id = receipts.claim(done);
    receipts.finish(id, { type: "job_end", job: done });
    receipts.claim(uncertain);
    expect(() => receipts.claim(uncertain)).toThrow("claim");
    receipts = new CronExecutionReceipts(path, store);
    const recovered = receipts.recover();
    expect(recovered.map((x) => x.notice.type)).toEqual(["job_error", "job_end", "job_error"]);
    expect(store.load()).toMatchObject([
      { id: "repeat", enabled: false, lastExecution: { status: "interrupted" } },
    ]);
    store.save([{ ...done, createdAt: 42 }]);
    receipts.acknowledge(id);
    expect(store.load()).toMatchObject([{ id: "done", createdAt: 42 }]);
    expect(receipts.recover().map((x) => x.id)).not.toContain(id);
    await writeFile(path, "invalid");
    expect(() => receipts.claim(job)).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
