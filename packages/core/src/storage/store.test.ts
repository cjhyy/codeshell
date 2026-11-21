import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { openStateStorage, type StateStorage } from "./store.js";
import { sqliteDriver } from "./driver.js";

const stores: StateStorage[] = [];
const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "codeshell-state-storage-"));
  dirs.push(dir);
  return dir;
}
async function open(root: string, workerUrl?: URL) {
  const store = await openStateStorage(root, { workerUrl });
  stores.push(store);
  return store;
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

test("WAL shares committed batches between hosts, isolates sibling roots, and rolls back the whole failed batch", async () => {
  const dir = await fixture();
  const [a, peer, other] = await Promise.all(
    ["sessions", "sessions", "alternate"].map((root) => open(join(dir, root))),
  );
  expect([a.mode, peer.mode, other.mode]).toEqual(["sqlite", "sqlite", "sqlite"]);
  expect(a.read("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
  expect(a.read("PRAGMA query_only")).toEqual([{ query_only: 1 }]);
  const insert = (id: string) => ({
    sql: "INSERT INTO sessions (id,state_mtime_ns) VALUES (?,?)",
    params: [id, "9007199254740993551"],
  });
  expect(await a.write([insert("committed")])).toBe(true);
  expect(await a.write([insert("rolled-back"), insert("committed")])).toBe(false);
  expect(peer.read("SELECT id,state_mtime_ns FROM sessions")).toEqual([
    { id: "committed", state_mtime_ns: "9007199254740993551" },
  ]);
  expect(other.read("SELECT id FROM sessions")).toEqual([]);
  expect(a.read("SELECT version FROM schema_migrations")).toEqual([{ version: 1 }, { version: 2 }]);
  await a.close();
  expect(peer.read("SELECT id FROM sessions")).toEqual([{ id: "committed" }]);
  expect((await readdir(join(dir, ".codeshell-state"))).length).toBe(2);
});

test("quarantines corruption and unknown schemas together with their sidecars, without changing JSON facts", async () => {
  const dir = await fixture();
  const root = join(dir, "sessions");
  const first = await open(root);
  const file = first.read<{ file: string }>("PRAGMA database_list")![0].file;
  await first.close();
  const facts = join(root, "fixture-state.json");
  await writeFile(facts, '{"title":"preserved"}');
  await writeFile(file, "unreadable sqlite fixture");
  const rebuilt = await open(root);
  expect(rebuilt.mode).toBe("sqlite");
  const bucket = dirname(dirname(file));
  const quarantines = async () =>
    (await readdir(bucket)).filter((v) => v.startsWith("quarantine-"));
  expect(await quarantines()).toHaveLength(1);
  expect(await readFile(join(bucket, (await quarantines())[0], "state.sqlite"), "utf8")).toBe(
    "unreadable sqlite fixture",
  );
  await rebuilt.close();
  const db = sqliteDriver()!(file);
  db.run("INSERT INTO schema_migrations VALUES (?,?)", [99, 0]);
  db.close();
  const afterUnknown = await open(root);
  expect(afterUnknown.read("SELECT version FROM schema_migrations")).toEqual([
    { version: 1 },
    { version: 2 },
  ]);
  expect(await quarantines()).toHaveLength(2);
  expect(await readFile(facts, "utf8")).toBe('{"title":"preserved"}');
});

test("an incompatible live peer falls back without renaming another process's open WAL", async () => {
  const dir = await fixture();
  const root = join(dir, "sessions");
  const owner = await open(root);
  expect(await owner.write([{ sql: "INSERT INTO schema_migrations VALUES (99,0)" }])).toBe(true);
  const peer = await open(root);
  expect(peer.mode).toBe("json");
  expect(await peer.write([{ sql: "DELETE FROM sessions" }])).toBe(false);
  expect(owner.read("SELECT version FROM schema_migrations ORDER BY version")).toEqual([
    { version: 1 },
    { version: 2 },
    { version: 99 },
  ]);
  await owner.close();
  const recovered = await open(root);
  expect(recovered.mode).toBe("sqlite");
});

test("publishes only initialized data, serializes registered JSON mutations, and retires a failed worker", async () => {
  const dir = await fixture();
  const worker = join(dir, "domain.mjs");
  const entry = new URL("./worker.ts", import.meta.url).href;
  await writeFile(
    worker,
    `
    import { join, dirname } from "node:path";
    import { serveStorageWorker } from ${JSON.stringify(entry)};
    await serveStorageWorker({
      async initialize({db}) {
        await new Promise(resolve=>setTimeout(resolve,5));
        db?.run("INSERT INTO sessions(id) VALUES (?)",["prepared"]);
      },
      async handle({sessionsRoot,mutateJsonFile},name) {
        if (name === "crash") { process.exit(23); return new Promise(() => {}); }
        if (name !== "increment") throw new Error("Unknown command");
        return mutateJsonFile(join(dirname(sessionsRoot),"counter.json"), {
          parse: raw=>raw ? JSON.parse(raw) : 0, serialize: JSON.stringify,
          mutation: current=>({value:current+1, result:current+1})
        });
      }
    });
  `,
  );
  const root = join(dir, "sessions");
  const s = await open(root, pathToFileURL(worker));
  expect(s.read("SELECT id FROM sessions")).toEqual([{ id: "prepared" }]);
  expect(await Promise.all([s.request("increment"), s.request("increment")])).toEqual([1, 2]);
  expect(await readFile(join(dir, "counter.json"), "utf8")).toBe("2");
  await expect(s.request("unknown")).rejects.toThrow("Unknown command");
  await expect(s.request("crash")).rejects.toThrow("acknowledging");
  expect(s.mode).toBe("json");
  expect(s.read("SELECT id FROM sessions")).toBeNull();
  expect(await s.request("increment")).toBeNull();
  expect(await s.write([{ sql: "DELETE FROM sessions" }])).toBe(false);
});

test("worker startup failure and an incapable storage root leave JSON callers in control", async () => {
  const dir = await fixture();
  const root = join(dir, "sessions");
  const s = await open(root, pathToFileURL(join(dir, "missing.mjs")));
  expect(s.mode).toBe("json");
  expect(await s.request("command")).toBeNull();
  await writeFile(root, "a file, not a directory");
  const badRoot = await open(root);
  expect(badRoot.mode).toBe("json");
  expect(await readFile(root, "utf8")).toBe("a file, not a directory");
});
