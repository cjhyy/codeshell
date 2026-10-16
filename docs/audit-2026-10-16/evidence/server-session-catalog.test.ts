import { expect, test, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// listDiskSessions/listSessions are filesystem readers. Core is used only by
// unrelated default-root/archive entrypoints; the explicit baseDir below makes
// any attempt to use those entrypoints fail instead of touching operator state.
mock.module("@cjhyy/code-shell-core", () => ({
  SessionManager: class { constructor() { throw new Error("unused Core archive boundary"); } },
  sessionsRoot: () => { throw new Error("fixture requires explicit owned root"); },
}));
const { listDiskSessions, listSessions } = await import("../../../packages/server/src/sessions-service.ts");
globalThis.fetch = (() => { throw new Error("Audit fixture denies all fetch"); }) as typeof fetch;
async function session(root: string, id: string, raw?: string, mtime = 1_800_000_000_000) {
  const dir = join(root, id);
  await mkdir(dir);
  await writeFile(join(dir, "state.json"), raw ?? JSON.stringify({
    sessionId: id, origin: "automation", parentSessionId: null,
    cwd: root, summary: id, status: "completed",
  }));
  await writeFile(join(dir, "transcript.jsonl"), "");
  await utimes(dir, mtime / 1000, mtime / 1000);
}

test("one syntactically valid non-object state prevents listing every healthy session", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-audit-catalog-corrupt-"));
  try {
    await session(root, "healthy");
    await session(root, "broken", "null");
    await expect(listDiskSessions({ limit: 50 }, root)).rejects.toThrow();
    // The neighboring public history reader already skips a non-object state.
    expect((await listSessions(root)).map((row) => row.id)).toEqual(["healthy"]);
    await rm(join(root, "broken"), { recursive: true });
    await session(root, "broken", "42");
    await expect(listDiskSessions({ limit: 50 }, root)).rejects.toThrow();
    await rm(join(root, "broken"), { recursive: true });
    await session(root, "broken", "not JSON");
    expect((await listDiskSessions({ limit: 50 }, root)).sessions.map((row) => row.id)).toEqual(["healthy"]);
    console.log("AUDIT null/number state abort whole disk catalog; malformed JSON is correctly skipped");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("equal directory mtime with valid mixed-case IDs skips a session between pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-audit-catalog-cursor-"));
  try {
    const ids = ["a000000000000000", "B000000000000000", "c000000000000000"];
    for (const id of ids) await session(root, id);
    expect(ids.slice().sort((a, b) => a.localeCompare(b))).toEqual(ids);
    const full = await listDiskSessions({ limit: 50 }, root);
    expect(full.sessions.map((row) => row.id)).toEqual(ids);
    const first = await listDiskSessions({ limit: 1 }, root);
    const second = await listDiskSessions({ limit: 1, cursor: first.nextCursor! }, root);
    expect(first.sessions.map((row) => row.id)).toEqual([ids[0]]);
    expect(second.sessions.map((row) => row.id)).toEqual([ids[2]]);
    expect(second.nextCursor).toBeNull();
    console.log("AUDIT tied directory mtimes: full=a,B,c; paged=a,c; B omitted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("different directory mtimes preserve all valid mixed-case IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-audit-catalog-cursor-control-"));
  try {
    const ids = ["a000000000000000", "B000000000000000", "c000000000000000"];
    for (const [index, id] of ids.entries()) await session(root, id, undefined, 1_800_000_000_000 - index * 1000);
    const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = await listDiskSessions({ limit: 1, cursor }, root);
      seen.push(...page.sessions.map((row) => row.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(ids);
  } finally { await rm(root, { recursive: true, force: true }); }
});
