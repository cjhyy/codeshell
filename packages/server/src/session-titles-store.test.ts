import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionTitlesStore, SessionTitleConflictError } from "./session-titles-store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hub-title-review-"));
  directories.push(directory);
  const file = join(directory, "titles.json");
  return { file, store: createSessionTitlesStore(file, { strictMutations: true }) };
}

test("independent title stores serialize bounded writes without blocking each other's async lock holder", async () => {
  const { file, store } = fixture();
  const other = createSessionTitlesStore(file, { strictMutations: true });
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? other : store).setTitle(`session-${index}`, `Title ${index}`),
    ),
  );
  expect(Object.keys(await store.listTitles())).toHaveLength(20);
  expect(JSON.parse(readFileSync(file, "utf8"))["session-19"]).toBe("Title 19");
});

test("strict writes preserve malformed raw entries while tolerant Desktop reads still filter them", async () => {
  const { file, store } = fixture();
  for (const raw of [
    '{"good":"Keep","bad":42}',
    '{"good":"Keep","constructor":"invalid"}',
    '{"good":"Keep", "bad":"unterminated}',
  ]) {
    writeFileSync(file, raw);
    await expect(store.setTitle("new", "New")).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(raw);
  }
  writeFileSync(file, '{"good":"Keep","bad":42}');
  expect(await createSessionTitlesStore(file).listTitles()).toEqual({ good: "Keep" });
});

test("title maps do not expose inherited Object prototype properties", async () => {
  const { store } = fixture();
  expect((await store.listTitles())["toString"]).toBeUndefined();
  await store.setTitle("toString", "A real session");
  expect((await store.listTitles())["toString"]).toBe("A real session");
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "non-root title writes work when only the data directory is writable",
  async () => {
    const { file } = fixture();
    const parent = join(file, "..");
    const data = join(parent, "data");
    mkdirSync(data);
    chmodSync(parent, 0o500);
    try {
      const store = createSessionTitlesStore(join(data, "titles.json"), { strictMutations: true });
      await store.setTitle("session", "Writable volume root");
      expect((await store.listTitles())["session"]).toBe("Writable volume root");
    } finally {
      chmodSync(parent, 0o700);
    }
  },
);

test("expected custom titles compare atomically against the latest independent writer", async () => {
  const { file, store } = fixture();
  const other = createSessionTitlesStore(file, { strictMutations: true });
  await store.setTitle("session", "First writer", { expectedTitle: null });
  await expect(
    other.setTitle("session", "Stale overwrite", { expectedTitle: "" }),
  ).rejects.toBeInstanceOf(SessionTitleConflictError);
  expect((await store.listTitles())["session"]).toBe("First writer");
  await other.setTitle("session", "", { expectedTitle: "First writer" });
  expect((await store.listTitles())["session"]).toBeUndefined();
});
