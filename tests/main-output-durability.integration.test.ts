import { afterAll, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { guardProjectScopeNetwork } from "../packages/server/src/panels/__fixtures__/project-scope-network.js";
guardProjectScopeNetwork(afterAll);
const { SessionManager, sessionsRoot } = await import("../packages/core/src/index.js");
const {
  SessionOutputJournal,
  SessionOutputPublisher,
  readOutputJournal,
  SessionOutputCoverageStore,
} = await import("../packages/core/src/index.internal.js");
const { MainOutputPublisher } =
  await import("../packages/desktop/src/main/main-output-publisher.js");
const { SessionSnapshotStore } =
  await import("../packages/desktop/src/main/SessionSnapshotStore.js");
const { WorkerBridgeCore } = await import("../packages/server/src/worker-bridge-core.js");
const { parseSnapshotAppend } = await import("../packages/desktop/src/main/parseStreamLine.js");
let serial = 0;
function fixture() {
  const root = sessionsRoot(),
    id = `main-producer-${++serial}`;
  const manager = new SessionManager(root);
  manager.create(root, "fixture", "fixture", id);
  const snapshots = new SessionSnapshotStore({
    coverage: new SessionOutputCoverageStore(() => root),
    maxPerSession: 1,
  });
  const applied: any[] = [];
  let main: InstanceType<typeof MainOutputPublisher>;
  const deliver = (event: any) => {
    if (!main.observeWorker(id, event)) return false;
    snapshots.append(id, event);
    applied.push(event);
    return true;
  };
  main = new MainOutputPublisher({
    root: () => root,
    latest: () => snapshots.get(id).outputCursor,
    worker: (_sid, event) => deliver(event),
  });
  const external = main.capture(id, (event) => {
    snapshots.append(id, event);
    applied.push(event);
    return true;
  });
  return { root, id, manager, snapshots, applied, main, external, deliver };
}

test("real stdout worker committed A + Main B are applied in cursor order before late A and remain complete", async () => {
  const f = fixture();
  const worker = new WorkerBridgeCore({
    entryPath: resolve("tests/fixtures/main-output-worker.mjs"),
    execPath: "node",
    buildEnv: () => ({ ...process.env, MAIN_OUTPUT_ROOT: f.root, MAIN_OUTPUT_SESSION: f.id }),
  });
  worker.subscribeLines((line) => {
    const append = parseSnapshotAppend(line);
    if (append) f.deliver(append.event);
  });
  worker.ensureWorker();
  let request = 0;
  const rpc = (method: string, params = {}) =>
    worker.request(method, params, {
      id: ++request,
      consume: true,
      timeoutMs: 5000,
      settleOnExit: true,
      failFast: true,
      meta: { origin: "host", producer: "main-output-fixture" },
    });
  try {
    for (const index of [1, 2]) {
      const held = await rpc("hold", { text: `native A${index}` });
      expect(held.status).toBe("result");
      expect((held as any).result.pid).not.toBe(process.pid);
      expect(f.applied.length).toBe((index - 1) * 2);
      f.external.publish({ type: "error", error: `Main B${index}` });
      expect(f.applied.slice(-2).map((event) => event.text ?? event.error)).toEqual([
        `native A${index}`,
        `Main B${index}`,
      ]);
      const before = f.snapshots.get(f.id).nextSeq;
      expect((await rpc("release")).status).toBe("result");
      expect(f.snapshots.get(f.id).nextSeq).toBe(before);
    }
    expect(f.snapshots.get(f.id).outputUnpaired).not.toBe(true);
    const page = readOutputJournal(f.root, f.id);
    expect(page.status).toBe("ok");
    expect(page.frames.map((frame) => frame.producer?.kind)).toEqual([
      "protocol",
      "host",
      "protocol",
      "host",
    ]);
  } finally {
    await worker.stopAndWait();
  }
});

test("captured asynchronous Main source and first late native cursor cannot bind a deleted/reused Session", () => {
  const f = fixture(),
    old = new SessionOutputPublisher(() => f.root, "protocol");
  const event = old.project(f.id, { type: "text_delta", text: "old native" });
  rmSync(join(f.root, f.id), { recursive: true });
  f.manager.create(f.root, "new", "fixture", f.id);
  f.main.forget(f.id);
  f.snapshots.forget(f.id);
  expect(() => f.external.publish({ type: "error", error: "late Main error" })).toThrow("replaced");
  expect(() => f.deliver(event)).toThrow("unverified");
  expect(f.applied).toHaveLength(0);
  expect(f.snapshots.get(f.id).nextSeq).toBe(1);
});

test("only actually applied late duplicates are suppressed; backwards unknowns and changed output keep barriers", () => {
  const f = fixture(),
    writer = new SessionOutputPublisher(() => f.root, "protocol");
  const event = writer.project(f.id, { type: "text_delta", text: "native A" }) as any;
  f.external.publish({ type: "error", error: "Main B" });
  expect(() => f.main.observeWorker(f.id, { ...event, text: "changed" })).toThrow("changed");
  expect(f.main.observeWorker(f.id, event)).toBe(false);
  expect(f.main.observeWorker(f.id, event)).toBe(true); // A second, unexplained duplicate is not silently ignored.
  f.snapshots.append(f.id, event);
  expect(f.snapshots.get(f.id).outputUnpaired).toBe(true);
});

test("manual repair pending receipt blocks readers and existing writers even if the anchor is still valid", () => {
  const f = fixture();
  const writer = new SessionOutputJournal(f.root, f.id, { kind: "host", id: "pending-fixture" });
  writer.append({ type: "error", error: "published" });
  const file = join(f.root, f.id, "output-journal.jsonl"),
    bytes = readFileSync(file);
  writeFileSync(join(f.root, f.id, "output-journal-repair-pending.json"), "damaged receipt");
  expect(readOutputJournal(f.root, f.id).status).toBe("incomplete");
  expect(() => writer.append({ type: "error", error: "must refuse" })).toThrow("pending");
  expect(readFileSync(file)).toEqual(bytes);
});
