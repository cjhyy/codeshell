import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "./cron-store.js";
import type { CronJob } from "./scheduler.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-store-"));
  file = join(dir, "cron.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: "1",
    name: "nightly",
    schedule: "1h",
    prompt: "do work",
    enabled: true,
    runCount: 0,
    createdAt: 1_000,
    ...over,
  };
}

describe("CronStore", () => {
  test("save then load round-trips jobs", () => {
    const store = new CronStore(file);
    const jobs = [job(), job({ id: "2", name: "other", enabled: false })];
    store.save(jobs);

    const loaded = new CronStore(file).load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].name).toBe("nightly");
    expect(loaded[1].enabled).toBe(false);
  });

  test("load returns empty array when file is absent", () => {
    expect(new CronStore(file).load()).toEqual([]);
  });

  test("load tolerates a corrupt file instead of throwing", () => {
    writeFileSync(file, "{ not json", "utf-8");
    expect(new CronStore(file).load()).toEqual([]);
  });

  test("save is atomic — leaves no .tmp file behind", () => {
    const store = new CronStore(file);
    store.save([job()]);
    expect(existsSync(file)).toBe(true);
    // No dangling tmp siblings.
    const leftovers = readFileSync(file, "utf-8");
    expect(leftovers).toContain("nightly");
  });

  test("save writes pretty JSON with a stable shape", () => {
    new CronStore(file).save([job()]);
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { jobs: CronJob[] };
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].prompt).toBe("do work");
  });
});
