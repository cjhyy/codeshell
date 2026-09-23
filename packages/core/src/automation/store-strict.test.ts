import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "./store.js";
import { CronScheduler } from "./scheduler.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cron-strict-"));
  roots.push(root);
  const file = join(root, "cron.json");
  const store = new CronStore(file, { strictRead: true });
  const scheduler = new CronScheduler(store);
  scheduler.setExecutionEnabled(false);
  return { root, file, store, scheduler };
}
const source = { appId: "quant-lab", revision: "a".repeat(64) };

test("Panel source survives update and reload, and unique replay cannot replace its package", () => {
  const f = fixture();
  const input = { ...source };
  const job = f.scheduler.create("daily", "1d", "inspect", {
    panelSource: input,
    creationKey: "panel:market",
  });
  input.revision = "b".repeat(64);
  expect(job.panelSource).toEqual(source);
  f.scheduler.update(job.id, { prompt: "updated" });
  expect(f.store.load()[0].panelSource).toEqual(source);
  expect(() =>
    f.scheduler.create("daily", "1d", "updated", {
      panelSource: input,
      creationKey: "panel:market",
    }),
  ).toThrow(/different definition/);
  for (const panelSource of [
    null,
    {},
    [],
    { ...source, appId: "../other" },
    { ...source, revision: "bad" },
  ])
    expect(() => f.scheduler.create("daily", "1d", "inspect", { panelSource } as any)).toThrow(
      /panelSource/,
    );
});

test("strict reads preserve corrupt bytes instead of silently dropping jobs on mutation", () => {
  const f = fixture();
  expect(f.store.load()).toEqual([]);
  const job = f.scheduler.create("daily", "1d", "inspect", {
    panelSource: source,
    creationKey: "panel:market",
  });
  const invalid = [
    "{ corrupt",
    "null",
    JSON.stringify({ jobs: [] }),
    JSON.stringify({ version: 2, jobs: [job] }),
    JSON.stringify({ version: 1, jobs: [job, null] }),
    JSON.stringify({ version: 1, jobs: [job, { ...job, id: "other" }] }),
    JSON.stringify({ version: 1, jobs: [job, { ...job, creationKey: "other" }] }),
    JSON.stringify({
      version: 1,
      jobs: [{ ...job, panelSource: { ...source, revision: "invalid" } }],
    }),
  ];
  for (const bytes of invalid) {
    writeFileSync(f.file, bytes);
    expect(() => f.store.load()).toThrow();
    expect(() => f.store.mutate((jobs) => ({ jobs, result: null }))).toThrow();
    expect(readFileSync(f.file, "utf8")).toBe(bytes);
  }
});

test("strict reads reject both live and dangling symlinks", () => {
  const f = fixture();
  const target = join(f.root, "target.json");
  symlinkSync(target, f.file);
  expect(() => f.store.load()).toThrow(/unsafe/);
  writeFileSync(target, JSON.stringify({ version: 1, jobs: [] }));
  expect(() => f.store.load()).toThrow(/unsafe/);
  expect(() => f.store.mutate((jobs) => ({ jobs, result: null }))).toThrow(/unsafe/);
});

test("strict save rejects duplicate creation keys while legacy storage remains compatible", () => {
  const f = fixture();
  const job = f.scheduler.create("daily", "1d", "inspect", { creationKey: "panel:market" });
  const bytes = readFileSync(f.file, "utf8");
  expect(() => f.store.save([job, { ...job, id: "other" }])).toThrow(/creation key/);
  expect(readFileSync(f.file, "utf8")).toBe(bytes);
  new CronStore(f.file).save([job, { ...job, id: "other" }]);
  expect(new CronStore(f.file).load()).toHaveLength(2);
});
