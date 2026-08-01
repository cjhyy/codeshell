// Lost-update protection for shared JSON files.
//
// Several subsystems did `read → modify → writeFileSync` with no cross-process
// lock. Atomic rename prevents a torn file but NOT a lost update: two writers
// both read revision N and both write N+1, so one change disappears. Measured on
// this repo before the fix: 48 concurrent settings writers (distinct keys) left
// 17 keys; 48 AutoDream increments recorded 1–2.
//
// These tests spawn REAL processes so the cross-process path is what is
// exercised — an in-process test would pass even with no lock at all.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateJsonFile, writeFileAtomic } from "./file-mutex.js";

const MUTEX_MODULE = join(import.meta.dir, "file-mutex.ts");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "file-mutex-"));
}

describe("mutateJsonFile", () => {
  test("reloads inside the lock so it never writes back a stale snapshot", () => {
    const dir = tmp();
    try {
      const file = join(dir, "state.json");
      writeFileSync(file, JSON.stringify({ a: 1 }));

      // Simulate the classic bug shape: capture a snapshot BEFORE mutating, then
      // let another writer land, then mutate. The mutation must observe the
      // other writer's value, not the stale capture.
      const stale = JSON.parse(readFileSync(file, "utf-8")) as Record<string, number>;
      mutateJsonFile<Record<string, number>>(file, {
        parse: (raw) => (raw ? JSON.parse(raw) : {}),
        serialize: (v) => JSON.stringify(v),
        mutation: (current) => ({ value: { ...current, b: 2 } }),
      });

      const observed: Record<string, number>[] = [];
      mutateJsonFile<Record<string, number>>(file, {
        parse: (raw) => (raw ? JSON.parse(raw) : {}),
        serialize: (v) => JSON.stringify(v),
        mutation: (current) => {
          observed.push(current);
          return { value: { ...current, c: 3 } };
        },
      });

      expect(stale).toEqual({ a: 1 });
      // Saw the intervening write.
      expect(observed[0]).toEqual({ a: 1, b: 2 });
      expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ a: 1, b: 2, c: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("treats a missing file as empty and creates it", () => {
    const dir = tmp();
    try {
      const file = join(dir, "nested", "new.json");
      mutateJsonFile<Record<string, number>>(file, {
        parse: (raw) => (raw === undefined ? {} : JSON.parse(raw)),
        serialize: (v) => JSON.stringify(v),
        mutation: (current) => ({ value: { ...current, created: 1 } }),
      });
      expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ created: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mutation returning no value does not rewrite the file", () => {
    const dir = tmp();
    try {
      const file = join(dir, "state.json");
      writeFileAtomic(file, JSON.stringify({ keep: true }));
      const before = readFileSync(file, "utf-8");
      const result = mutateJsonFile<Record<string, unknown>, string>(file, {
        parse: (raw) => (raw ? JSON.parse(raw) : {}),
        serialize: (v) => JSON.stringify(v),
        mutation: () => ({ result: "no-op" }),
      });
      expect(result).toBe("no-op");
      expect(readFileSync(file, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("48 concurrent PROCESSES each adding a distinct key lose nothing", async () => {
    const dir = tmp();
    try {
      const file = join(dir, "keys.json");
      writeFileAtomic(file, JSON.stringify({ sentinel: "keep" }));

      const total = 48;
      const script = (key: string) => `
        import { mutateJsonFile } from ${JSON.stringify(MUTEX_MODULE)};
        mutateJsonFile(${JSON.stringify(file)}, {
          parse: (raw) => (raw ? JSON.parse(raw) : {}),
          serialize: (v) => JSON.stringify(v),
          mutation: (current) => ({ value: { ...current, ${JSON.stringify(key)}: 1 } }),
        });
      `;

      // Spawn all writers, then await them together so they genuinely contend.
      const procs = Array.from({ length: total }, (_, i) =>
        Bun.spawn([process.execPath, "-e", script(`k${i}`)], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const codes = await Promise.all(procs.map((p) => p.exited));

      expect(codes.every((c) => c === 0)).toBe(true);
      const final = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      // Pre-fix this was ~17 of 48.
      for (let i = 0; i < total; i += 1) {
        expect(final[`k${i}`]).toBe(1);
      }
      // An unrelated pre-existing key must survive too.
      expect(final.sentinel).toBe("keep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("48 concurrent PROCESSES incrementing one counter lose no increments", async () => {
    // The AutoDream cadence shape: read → +1 → write.
    const dir = tmp();
    try {
      const file = join(dir, "counter.json");
      writeFileAtomic(file, JSON.stringify({ n: 0 }));

      const total = 48;
      const script = `
        import { mutateJsonFile } from ${JSON.stringify(MUTEX_MODULE)};
        mutateJsonFile(${JSON.stringify(file)}, {
          parse: (raw) => (raw ? JSON.parse(raw) : { n: 0 }),
          serialize: (v) => JSON.stringify(v),
          mutation: (current) => ({ value: { n: current.n + 1 } }),
        });
      `;
      const procs = Array.from({ length: total }, () =>
        Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }),
      );
      const codes = await Promise.all(procs.map((p) => p.exited));

      expect(codes.every((c) => c === 0)).toBe(true);
      // Pre-fix this recorded 1–2.
      expect((JSON.parse(readFileSync(file, "utf-8")) as { n: number }).n).toBe(total);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
