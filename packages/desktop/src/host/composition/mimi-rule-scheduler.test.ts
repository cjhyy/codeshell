import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { StoredMimiRules } from "./mimi-rules.js";
import { hostedMimiRuleScheduler } from "./mimi-rule-scheduler.js";
import { HostScheduler } from "../automation/host-scheduler.js";
import { CronPeer, nodeCronPort } from "../automation/peer.js";
import { ruleScheduleKey } from "../../main/pet/pet-rule-schedule.js";

test("the Host claims simultaneous scheduler wakes once before requesting one native notification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-mimi-wake-"));
  const id = "rule-00000000-0000-4000-8000-000000000011";
  const at = Date.now() - 500;
  await writeFile(
    join(directory, "rules.json"),
    JSON.stringify({
      version: 1,
      rules: [
        {
          id,
          version: 1,
          origin: "user",
          createdBy: "follow-up",
          when: {
            kind: "schedule",
            at,
            timezone: "UTC",
            missedPolicy: "fire-once",
            catchUpUntil: at + 60_000,
          },
          then: { mode: "remind", title: "test", text: "synthetic" },
          wake: { occurrence: at, status: "scheduled" },
          attention: "always",
          channel: "desktop",
          target: { kind: "owner" },
          state: "active",
          createdAt: at - 1000,
          updatedAt: at,
        },
      ],
      quarantine: [],
    }),
  );
  const ports = new MessageChannel();
  const storage = new CronPeer(nodeCronPort(ports.port2), async (method) => {
    if (method === "start" || method === "stop") return;
    throw Error("Unexpected scheduler disk operation " + method);
  });
  const host = new HostScheduler(ports.port1, {
    run: async () => {
      throw Error("Unexpected model invocation");
    },
  });
  const table = new StoredMimiRules(directory);
  const ruleScheduler = hostedMimiRuleScheduler({
    petDir: directory,
    rule: (call) => table.run({ call, permit: new Int32Array(new SharedArrayBuffer(4)) }),
    cron: async () => {
      throw Error("Unexpected scheduler edit");
    },
    fire: (...args) => host.fireRule(...args),
    report: () => {},
  });
  host.rules = ruleScheduler.coordinator;
  const nativePorts = new MessageChannel();
  const online = Promise.withResolvers<void>();
  const requested: string[] = [];
  const native = new CronPeer(nodeCronPort(nativePorts.port2), async (method, input) => {
    if (method === "online") {
      online.resolve();
      return;
    }
    if (method !== "fireRule") throw Error("Unexpected native command " + method);
    const [rule, due] = input as [{ id: string; wake: { status: string } }, { key: string }];
    expect(rule.id).toBe(id);
    expect(rule.wake.status).toBe("claimed");
    requested.push(due.key);
    return { status: "notified", detail: "accepted" };
  });
  try {
    host.bind(nodeCronPort(nativePorts.port1), "");
    await online.promise;
    const job = { creationKey: ruleScheduleKey(id, 1, at) };
    await Promise.all([storage.call("execute", job), storage.call("execute", job)]);
    await storage.call("deliver", { type: "job_missed", job });
    expect(requested).toEqual([job.creationKey]);
    expect(
      await table.run({
        call: { method: "get", args: [id] },
        permit: new Int32Array(new SharedArrayBuffer(4)),
      }),
    ).toMatchObject({ ok: true, value: { wake: { status: "notified", detail: "accepted" } } });
  } finally {
    await host.close();
    native.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
