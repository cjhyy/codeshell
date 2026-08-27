import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "./store.js";
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
    const jobs = [
      job({
        projectId: "project-1",
        rootId: "root-2",
        templateSource: {
          installKey: "review@local",
          templateId: "nightly-review",
          revision: "a".repeat(64),
          pluginVersion: "1.2.3",
        },
      }),
      job({ id: "2", name: "other", enabled: false }),
    ];
    store.save(jobs);

    const loaded = new CronStore(file).load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].name).toBe("nightly");
    expect(loaded[0].templateSource).toEqual(jobs[0].templateSource);
    expect(loaded[0]).toMatchObject({ projectId: "project-1", rootId: "root-2" });
    expect(loaded[1].enabled).toBe(false);
  });

  test("load returns empty array when file is absent", () => {
    expect(new CronStore(file).load()).toEqual([]);
  });

  test("load tolerates a corrupt file instead of throwing", () => {
    writeFileSync(file, "{ not json", "utf-8");
    expect(new CronStore(file).load()).toEqual([]);
  });

  test("isolates malformed persisted jobs instead of discarding valid siblings", () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        jobs: [
          job({ id: "keep" }),
          null,
          job({ id: "bad-schedule", schedule: "every whenever" }),
          { ...job({ id: "bad-prompt" }), prompt: 42 },
        ],
      }),
      "utf-8",
    );
    expect(new CronStore(file).load().map((entry) => entry.id)).toEqual(["keep"]);
  });

  test("rejects duplicate ids and oversized automation payloads on save", () => {
    const store = new CronStore(file);
    expect(() => store.save([job(), job()])).toThrow(/duplicate/i);
    expect(() => store.save([job({ prompt: "x".repeat(1024 * 1024 + 1) })])).toThrow(
      /invalid cron job/i,
    );
    expect(existsSync(file)).toBe(false);
    expect(() => store.save([job({ projectId: "x".repeat(513), rootId: "root-1" })])).toThrow(
      /invalid cron job/i,
    );
  });

  test("save is atomic — leaves no .tmp file behind", () => {
    const store = new CronStore(file);
    store.save([job()]);
    expect(existsSync(file)).toBe(true);
    // No dangling tmp siblings.
    const leftovers = readFileSync(file, "utf-8");
    expect(leftovers).toContain("nightly");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("stores automation prompts owner-only and tightens legacy rewrites", () => {
    const store = new CronStore(file);
    store.save([job({ prompt: "private prompt" })]);
    if (process.platform === "win32") return;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o644);
    store.save([job({ prompt: "still private" })]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("save writes pretty JSON with a stable shape", () => {
    new CronStore(file).save([job()]);
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { jobs: CronJob[] };
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].prompt).toBe("do work");
  });
});
