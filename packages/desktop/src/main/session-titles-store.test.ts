import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setSessionTitlesFileForTest,
  listTitles,
  setTitle,
} from "./session-titles-store.js";

describe("session-titles-store", () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codeshell-session-titles-"));
    file = join(root, "desktop", "session-titles.json");
    __setSessionTitlesFileForTest(file);
  });

  afterEach(async () => {
    __setSessionTitlesFileForTest(null);
    await rm(root, { recursive: true, force: true });
  });

  test("keeps every concurrent rename and writes atomically owner-only", async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, index) => setTitle(`session-${index}`, `Title ${index}`)),
    );
    const titles = await listTitles();
    expect(Object.keys(titles)).toHaveLength(40);
    expect(titles["session-23"]).toBe("Title 23");
    const raw = await readFile(file, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("isolates corrupt or invalid shapes and can recover on the next rename", async () => {
    await writeFile(file, '["wrong shape"]', "utf8").catch(async () => {
      // Parent is absent on a new fixture.
      await setTitle("bootstrap", "temporary");
      await writeFile(file, '["wrong shape"]', "utf8");
    });
    expect(await listTitles()).toEqual({});
    await setTitle("session-ok", "Recovered");
    expect(await listTitles()).toEqual({ "session-ok": "Recovered" });
  });

  test("rejects traversal-shaped ids and unbounded titles", async () => {
    expect(() => setTitle("../escape", "bad")).toThrow(/session id/);
    expect(() => setTitle("session-ok", "x".repeat(1_025))).toThrow(/session title/);
  });

  test("ignores and refuses to replace a linked title registry", async () => {
    const outside = join(root, "outside.json");
    await mkdir(join(root, "desktop"), { recursive: true });
    await writeFile(outside, JSON.stringify({ "session-outside": "Keep" }));
    await symlink(outside, file);

    expect(await listTitles()).toEqual({});
    await expect(setTitle("session-new", "New")).rejects.toThrow(/regular file/);
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual({ "session-outside": "Keep" });
  });

  test("bounds title registry reads", async () => {
    await mkdir(join(root, "desktop"), { recursive: true });
    await writeFile(file, "x".repeat(4 * 1024 * 1024 + 1));
    expect(await listTitles()).toEqual({});
  });
});
