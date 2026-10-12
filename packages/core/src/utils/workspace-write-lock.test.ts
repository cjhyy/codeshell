import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWorkspaceWriteLock } from "./workspace-write-lock.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workspace-write-lock-"));
  directories.push(directory);
  return directory;
}

test("contending workspace writers wait asynchronously and share Unicode/case aliases", async () => {
  const directory = fixture();
  const release = await acquireWorkspaceWriteLock(directory, "Résumé.JSON");
  const hash = createHash("sha256").update("résumé.json").digest("hex");
  expect(readdirSync(directory)).toEqual([`.codeshell-workspace-write-${hash}.lock`]);
  let acquired = false;
  const pending = acquireWorkspaceWriteLock(directory, "Re\u0301sume\u0301.json").then((unlock) => {
    acquired = true;
    return unlock;
  });
  const releaseOther = await acquireWorkspaceWriteLock(directory, "other.json");
  await new Promise((done) => setTimeout(done, 60));
  expect(acquired).toBe(false);
  await release();
  await (
    await pending
  )();
  await releaseOther();
  expect(readdirSync(directory)).toEqual([]);
});

test("real processes hold the workspace lock across read, staging, and publication", async () => {
  const directory = fixture();
  const target = join(directory, "state.json");
  writeFileSync(target, "0");
  const module = new URL("./workspace-write-lock.ts", import.meta.url).href;
  const processes = Array.from({ length: 8 }, () => {
    const script = `
      import { acquireWorkspaceWriteLock } from ${JSON.stringify(module)};
      import { readFileSync, writeFileSync, renameSync } from "node:fs";
      const release = await acquireWorkspaceWriteLock(${JSON.stringify(directory)}, "state.json");
      try {
        const value = Number(readFileSync(${JSON.stringify(target)}, "utf8"));
        const staged = ${JSON.stringify(target)} + "." + process.pid + ".tmp";
        writeFileSync(staged, String(value + 1));
        await new Promise(done => setTimeout(done, 30));
        renameSync(staged, ${JSON.stringify(target)});
      } finally { await release(); }
    `;
    return Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  });
  const results = await Promise.all(
    processes.map(async (child) => ({
      exit: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })),
  );
  expect(results).toEqual(Array.from({ length: 8 }, () => ({ exit: 0, stderr: "" })));
  expect(readFileSync(target, "utf8")).toBe("8");
  expect(readdirSync(directory)).toEqual(["state.json"]);
});

test("times out without stealing an occupied lock or blocking timers", async () => {
  const directory = fixture();
  const release = await acquireWorkspaceWriteLock(directory, "state.json");
  const started = Date.now();
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 25);
  try {
    await expect(acquireWorkspaceWriteLock(directory, "state.json")).rejects.toMatchObject({
      code: "ELOCKED",
    });
    expect(ticked).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    expect(readdirSync(directory)).toHaveLength(1);
  } finally {
    clearTimeout(timer);
    await release();
  }
});

test("release refuses to remove a replacement lock", async () => {
  const directory = fixture();
  const release = await acquireWorkspaceWriteLock(directory, "state.json");
  const lock = join(directory, readdirSync(directory)[0]!);
  renameSync(lock, `${lock}.original`);
  mkdirSync(lock);
  await expect(release()).rejects.toMatchObject({ code: "ELOCKCOMPROMISED" });
  expect(readdirSync(directory)).toHaveLength(2);
});

test("an unexpected lock file fails closed and preserves its filesystem cause", async () => {
  const directory = fixture();
  const hash = createHash("sha256").update("state.json").digest("hex");
  const lock = join(directory, `.codeshell-workspace-write-${hash}.lock`);
  writeFileSync(lock, "unrelated file");
  await expect(acquireWorkspaceWriteLock(directory, "state.json")).rejects.toMatchObject({
    message: "workspace write lock is not a real directory",
    cause: { code: "EEXIST" },
  });
  expect(readFileSync(lock, "utf8")).toBe("unrelated file");
});
