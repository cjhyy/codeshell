import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler } from "./scheduler.js";
import { CronStore } from "./store.js";

let root: string;
const schedulers: CronScheduler[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cron-unique-"));
});
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stopAll();
  rmSync(root, { recursive: true, force: true });
});
function scheduler(persistent = true) {
  const value = new CronScheduler(persistent ? new CronStore(join(root, "cron.json")) : undefined);
  value.setExecutionEnabled(false);
  schedulers.push(value);
  return value;
}
const options = {
  creationKey: "panel:test",
  cwd: "/workspace",
  resumeSessionId: "session-1",
  permissionLevel: "full" as const,
};

test("replays reuse the retained job across instances and restarts without enabling paused jobs", () => {
  for (const persistent of [false, true]) {
    const one = scheduler(persistent);
    const original = one.create("daily", "1h", "check", options);
    one.pause(original.id);
    const two = persistent ? scheduler(true) : one;
    const replay = two.create("daily", "1h", "check", options);
    expect(replay.id).toBe(original.id);
    expect(replay.enabled).toBe(false);
    expect(replay.createdAt).toBe(original.createdAt);
    expect(two.list()).toHaveLength(1);
    expect(replay.creationKey).toBe(options.creationKey);
  }
});

test("the same key cannot replace content or authority, while unkeyed creates remain independent", () => {
  const s = scheduler();
  const original = s.create("daily", "1h", "check", options);
  for (const [name, schedule, prompt, opts] of [
    ["other", "1h", "check", options],
    ["daily", "2h", "check", options],
    ["daily", "1h", "changed", options],
    ["daily", "1h", "check", { ...options, cwd: "/other" }],
    ["daily", "1h", "check", { ...options, resumeSessionId: "other" }],
    ["daily", "1h", "check", { ...options, permissionLevel: "read-only" }],
  ] as const)
    expect(() => s.create(name, schedule, prompt, opts)).toThrow(/different definition/);
  expect(s.get(original.id)?.prompt).toBe("check");
  expect(s.list()).toHaveLength(1);
  s.create("daily", "1h", "check");
  s.create("daily", "1h", "check");
  expect(s.list()).toHaveLength(3);
});

test("updates retain the identity and require explicit review before replay; deletion releases the slot", () => {
  const s = scheduler();
  const job = s.create("daily", "1h", "check", options);
  s.update(job.id, { prompt: "new prompt" });
  expect(s.get(job.id)?.creationKey).toBe(options.creationKey);
  expect(() => scheduler().create("daily", "1h", "check", options)).toThrow(/different definition/);
  expect(scheduler().create("daily", "1h", "new prompt", options).id).toBe(job.id);
  s.delete(job.id);
  expect(scheduler().create("daily", "1h", "check", options).prompt).toBe("check");
  expect(new CronStore(join(root, "cron.json")).load()).toHaveLength(1);
});

test("invalid identities and duplicate persisted identities fail without changing the file", () => {
  const s = scheduler();
  const one = s.create("daily", "1h", "check", options);
  for (const creationKey of ["", "a".repeat(257), "key\n", null, 42])
    expect(() => s.create("daily", "1h", "check", { ...options, creationKey } as any)).toThrow(
      /creationKey/,
    );
  const store = new CronStore(join(root, "cron.json"));
  expect(() => store.save([{ ...one, creationKey: "bad key" }])).toThrow(/creationKey/);
  store.save([one, { ...one, id: "second" }]);
  const before = readFileSync(join(root, "cron.json"), "utf8");
  expect(() => s.create("daily", "1h", "check", options)).toThrow(/duplicate persisted/);
  expect(readFileSync(join(root, "cron.json"), "utf8")).toBe(before);
});

test("four independent processes atomically create one retained job", async () => {
  const storeSource = new URL("./store.ts", import.meta.url).href;
  const schedulerSource = new URL("./scheduler.ts", import.meta.url).href;
  const gate = join(root, "start");
  const children = Array.from({ length: 4 }, (_, index) =>
    Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
    import { existsSync, writeFileSync } from "node:fs";
    import { CronStore } from ${JSON.stringify(storeSource)};
    import { CronScheduler } from ${JSON.stringify(schedulerSource)};
    const scheduler = new CronScheduler(new CronStore(${JSON.stringify(join(root, "cron.json"))}));
    scheduler.setExecutionEnabled(false);
    writeFileSync(${JSON.stringify(join(root, `ready-${index}`))}, "ready");
    while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(5);
    const job = scheduler.create("daily", "1h", "check", ${JSON.stringify(options)});
    console.log(job.id);
  `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  try {
    const deadline = Date.now() + 5000;
    while (!children.every((_, index) => existsSync(join(root, `ready-${index}`)))) {
      if (Date.now() > deadline) throw Error("child initialization timed out");
      await Bun.sleep(5);
    }
    writeFileSync(gate, "go");
    const result = await Promise.all(
      children.map(async (child) => {
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, err).toBe(0);
        return out.trim();
      }),
    );
    expect(new Set(result).size).toBe(1);
    expect(new CronStore(join(root, "cron.json")).load()).toHaveLength(1);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}, 10000);
