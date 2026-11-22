import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionIndex } from "./session-index.js";
import { openStateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { listSessions } from "./sessions-service.js";

test("history preserves flat files, directory precedence and private sessions across reconciliation and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-history-index-"));
  const dir = join(root, "current");
  const entry = new URL("./session-index-worker.ts", import.meta.url);
  let catalog = createSessionIndex(root, { workerUrl: entry });
  try {
    for (const id of ["current", "pet", "sub", "qchat-1", "bad"]) await mkdir(join(root, id));
    await writeFile(join(dir, "state.json"), JSON.stringify({ title: "会话", startedAt: 100 }));
    await writeFile(join(dir, "transcript.jsonl"), "content");
    await writeFile(join(root, "current.jsonl"), "older copy");
    await writeFile(join(root, "legacy.json"), "old");
    await writeFile(join(root, "pet", "state.json"), JSON.stringify({ kind: "pet" }));
    await writeFile(
      join(root, "sub", "state.json"),
      JSON.stringify({ parentSessionId: "current" }),
    );
    await writeFile(join(root, "qchat-1", "state.json"), "{}");
    await writeFile(join(root, "bad", "state.json"), "invalid JSON");
    if (process.platform !== "win32") await symlink(dir, join(root, "alias"));
    await catalog.reconcile();
    expect(await catalog.history()).toEqual(await listSessions(root));
    expect((await catalog.history()).map((r) => r.id).sort()).toEqual(["current", "legacy"]);
    await writeFile(join(dir, "transcript.jsonl"), "longer transcript");
    await catalog.changed("current");
    expect(await catalog.history()).toEqual(await listSessions(root));
    await rm(dir, { recursive: true });
    await catalog.changed("current");
    expect((await catalog.history()).find((row) => row.id === "current")?.file).toBe(
      join(root, "current.jsonl"),
    );
    await rm(join(root, "legacy.json"));
    await catalog.changed("legacy.json");
    expect((await catalog.history()).map((row) => row.id)).toEqual(["current"]);
    await catalog.close();
    catalog = createSessionIndex(root, { workerUrl: entry });
    expect(await catalog.history()).toEqual(await listSessions(root));
    expect(await readFile(join(root, "current.jsonl"), "utf8")).toBe("older copy");
  } finally {
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable session leaves the other indexed rows available and returns once readable",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-history-permissions-"));
    const hidden = join(root, "private");
    const storage = openStateStorage(root, {
      workerUrl: new URL("./session-index-worker.ts", import.meta.url),
    });
    const catalog = createSessionIndex(root, { storage });
    try {
      for (const id of ["private", "readable"]) {
        await mkdir(join(root, id));
        await writeFile(join(root, id, "state.json"), JSON.stringify({ title: id }));
      }
      const db = await storage;
      expect(db.mode).toBe("sqlite");
      await catalog.reconcile();
      await chmod(hidden, 0);
      await catalog.reconcile();
      const ids = () =>
        db
          .read<{ id: string }>("SELECT id FROM session_history WHERE file IS NOT NULL ORDER BY id")
          ?.map((row) => row.id);
      expect(ids()).toEqual(["readable"]);
      expect((await catalog.history()).map((row) => row.id)).toEqual(["readable"]);
      await chmod(hidden, 0o700);
      await catalog.changed("private");
      expect(ids()).toEqual(["private", "readable"]);
    } finally {
      await chmod(hidden, 0o700).catch(() => {});
      await catalog.close();
      await (await storage).close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
