import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

// Install before the actual Core-backed reader is imported. These disk-only
// fixtures have no allowed HTTP origin, provider, listener, or model request.
let networkAttempts = 0;
const denyNetwork = () => {
  networkAttempts++;
  throw new Error("Session catalog fixture refuses network");
};
const originalFetch = globalThis.fetch;
const originals = [http, https].map((module) => ({
  module,
  request: module.request,
  get: module.get,
}));
globalThis.fetch = denyNetwork as unknown as typeof fetch;
for (const { module } of originals) {
  module.request = denyNetwork as typeof module.request;
  module.get = denyNetwork as typeof module.get;
}
syncBuiltinESMExports();
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const { module, request, get } of originals) Object.assign(module, { request, get });
  syncBuiltinESMExports();
});
const { listDiskSessions, listSessions } = await import("./sessions-service");

describe("disk session catalog recovery", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codeshell-session-catalog-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    expect(networkAttempts).toBe(0);
  });

  function session(id: string, raw?: string, mtime = 1_800_000_000_000) {
    const directory = path.join(root, id);
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, "state.json"),
      raw ?? JSON.stringify({ origin: "desktop", parentSessionId: null, cwd: root, title: id }),
    );
    fs.writeFileSync(path.join(directory, "transcript.jsonl"), "");
    fs.utimesSync(directory, new Date(mtime), new Date(mtime));
  }

  async function allPages(limit: number, cursor?: string) {
    const collected: string[] = [];
    const cursors = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await listDiskSessions({ limit, cursor }, root);
      collected.push(...result.sessions.map((row) => row.id));
      if (result.nextCursor === null) return collected;
      expect(cursors.has(result.nextCursor)).toBe(false);
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("Disk catalog cursor did not finish");
  }

  it.each(["null", "42", "[]", "[null,42]", '"text"', "true", "not JSON"])(
    "isolates invalid record %s without hiding or rewriting healthy sessions",
    async (raw) => {
      session("healthy", undefined, 1000);
      session("broken", raw, 2000);
      const healthyFile = path.join(root, "healthy", "state.json");
      const before = fs.readFileSync(healthyFile, "utf8");
      expect((await listDiskSessions({ limit: 1 }, root)).sessions.map((row) => row.id)).toEqual([
        "healthy",
      ]);
      expect((await listSessions(root)).map((row) => row.id)).toEqual(["healthy"]);
      expect(fs.readFileSync(healthyFile, "utf8")).toBe(before);
      expect(fs.readFileSync(path.join(root, "broken", "state.json"), "utf8")).toBe(raw);
    },
  );

  const ids = ["a000000000000000", "B000000000000000", "c000000000000000"];
  it("paginates every mixed-case ID with equal real directory mtimes", async () => {
    for (const id of ids) session(id);
    expect(new Set(ids.map((id) => fs.statSync(path.join(root, id)).mtimeMs)).size).toBe(1);
    const full = (await listDiskSessions({ limit: 50 }, root)).sessions.map((row) => row.id);
    expect(full).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(await allPages(1)).toEqual(full);
    expect(await allPages(2)).toEqual(full);
  });

  it("continues a tied-mtime cursor after its prior boundary record is deleted", async () => {
    for (const id of ids) session(id);
    const full = (await listDiskSessions({ limit: 50 }, root)).sessions.map((row) => row.id);
    const first = await listDiskSessions({ limit: 1 }, root);
    expect(first.nextCursor).not.toBeNull();
    fs.rmSync(path.join(root, first.sessions[0]!.id), { recursive: true });
    expect(await allPages(1, first.nextCursor!)).toEqual(full.slice(1));
  });

  it("keeps the different-mtime healthy pagination control complete", async () => {
    for (const [index, id] of ids.entries()) session(id, undefined, 3000 - index * 1000);
    expect(await allPages(1)).toEqual(ids);
  });
});
