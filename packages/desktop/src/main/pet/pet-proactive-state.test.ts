import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  heartbeatToday,
  HEARTBEAT_SEEN_MAX,
  localDayIndex,
  localDayStart,
  PetProactiveStateStore,
} from "./pet-proactive-state.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-proactive-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("PetProactiveStateStore", () => {
  test("counts and brief marks survive a restart", async () => {
    const path = join(dir, "pet", "proactive.json");
    const store = new PetProactiveStateStore(path);
    await store.update((draft) => {
      draft.briefs.morning = { sentAt: 1_000, day: 19_675 };
      draft.heartbeat = { lastAt: 2_000, day: 19_675, judged: 3, said: 1, seen: ["a", "b"] };
    });
    const restarted = new PetProactiveStateStore(path);
    await restarted.load();
    expect(restarted.get()).toEqual({
      briefs: { morning: { sentAt: 1_000, day: 19_675 } },
      heartbeat: { lastAt: 2_000, day: 19_675, judged: 3, said: 1, seen: ["a", "b"] },
    });
  });

  test("an unreadable file is moved aside and the state starts empty", async () => {
    const path = join(dir, "proactive.json");
    await writeFile(path, JSON.stringify({ version: 1, briefs: {}, heartbeat: { judged: -1 } }));
    const store = new PetProactiveStateStore(path);
    await store.load();
    expect(store.get().heartbeat).toEqual({ judged: 0, said: 0, seen: [] });
    expect((await readdir(dir)).some((name) => name !== "proactive.json")).toBe(true);
  });

  test("the seen list is bounded, oldest first out", async () => {
    const store = new PetProactiveStateStore(join(dir, "proactive.json"));
    const keys = Array.from({ length: HEARTBEAT_SEEN_MAX + 5 }, (_, index) => `k${index}`);
    const state = await store.update((draft) => {
      draft.heartbeat.seen = keys;
    });
    expect(state.heartbeat.seen).toHaveLength(HEARTBEAT_SEEN_MAX);
    expect(state.heartbeat.seen[0]).toBe("k5");
  });
});

describe("local days", () => {
  test("day index and start follow the owner's offset; counts reset on a new day", () => {
    // 2023-11-14 22:13 UTC is already the 15th in UTC+8.
    const at = Date.UTC(2023, 10, 14, 22, 13);
    expect(localDayIndex(at, 480)).toBe(localDayIndex(at, 0) + 1);
    expect(localDayStart(localDayIndex(at, 480), 480)).toBe(Date.UTC(2023, 10, 14, 16, 0));
    const beat = { day: 5, judged: 8, said: 4, seen: ["x"], lastAt: 1 };
    expect(heartbeatToday(beat, 5)).toBe(beat);
    expect(heartbeatToday(beat, 6)).toEqual({ day: 6, judged: 0, said: 0, seen: ["x"], lastAt: 1 });
  });
});
