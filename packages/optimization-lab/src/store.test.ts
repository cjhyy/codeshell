import { afterEach, describe, expect, test } from "bun:test";
import {
  statSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ExperimentStore } from "./store.js";
import { canonicalJson } from "./contracts/canonical-json.js";
import { fixture, grantFor } from "./test-fixtures/foundation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const value = fixture();
  roots.push(value.root);
  return value;
}

describe("bounded experiment storage", () => {
  test("rejects external IDs and stale state revisions", () => {
    const f = setup();
    for (const id of ["../outside", "exp_../../outside", f.id + "/../outside", ""])
      expect(() => f.store.read(id)).toThrow();
    const snapshot = f.store.read(f.id);
    const next = f.store.mutate(
      f.id,
      { expectedRevision: snapshot.state.revision, fence: f.fence },
      (state) => {
        state.data.step = "baseline";
      },
    );
    expect(next.state.revision).toBe(snapshot.state.revision + 1);
    expect(() =>
      f.store.mutate(f.id, { expectedRevision: snapshot.state.revision }, () => {}),
    ).toThrow("stale");
    expect(() =>
      f.store.mutate(f.id, { fence: f.fence }, (state) => {
        state.grantRevision = 0;
      }),
    ).toThrow("control fields");
  });
  test("active writers require fence and started/stop control cannot be rewritten", () => {
    const f = setup();
    expect(() => f.store.mutate(f.id, {}, () => {})).toThrow("requires lease fence");
    const startedAt = new Date(f.now()).toISOString();
    f.store.mutate(f.id, { fence: f.fence }, (state) => {
      state.startedAt = startedAt;
    });
    expect(() =>
      f.store.mutate(f.id, { fence: f.fence }, (state) => {
        state.startedAt = null;
      }),
    ).toThrow("start time");
    f.store.requestStop(f.id);
    expect(() =>
      f.store.mutate(f.id, { fence: f.fence }, (state) => {
        state.stopRequested = false;
      }),
    ).toThrow("control fields");
    f.lease.release(f.id, f.fence);
    expect(
      f.store.mutate(f.id, {}, (state) => {
        state.data.localGrade = "allowed";
      }).state.data.localGrade,
    ).toBe("allowed");
  });
  test("stores immutable artifacts and detects corruption and symlinks", () => {
    const f = setup();
    const artifact = f.store.putJson(f.id, "trials", { answer: "hello" }, f.fence);
    expect(f.store.putJson(f.id, "trials", { answer: "hello" }, f.fence)).toEqual(artifact);
    expect(f.store.getJson(f.id, "trials", artifact.hash)).toEqual({ answer: "hello" });
    writeFileSync(artifact.path, "{}");
    expect(() => f.store.getJson(f.id, "trials", artifact.hash)).toThrow("corrupt");
    expect(() => f.store.putJson(f.id, "trials", { answer: "hello" }, f.fence)).toThrow(
      "corruption",
    );
    rmSync(artifact.path);
    const target = join(f.root, "other.json");
    writeFileSync(target, "{}");
    symlinkSync(target, artifact.path);
    expect(() => f.store.getJson(f.id, "trials", artifact.hash)).toThrow("unsafe");
    expect(() => f.store.putJson(f.id, "../skills", {}, f.fence)).toThrow("identity");
  });
  test("staging crash leftovers never appear runnable and no temp files remain", () => {
    const f = setup();
    mkdirSync(join(f.root, "experiments", ".pending_orphan"));
    writeFileSync(join(f.root, "experiments", ".pending_orphan", "plan.json"), "{}");
    expect(f.store.list()).toHaveLength(1);
    expect(readdirSync(f.store.directory(f.id)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });
  test("non-owner host writes stop intent without requiring execution lease", () => {
    const f = setup();
    const other = new ExperimentStore(f.root);
    const before = other.read(f.id);
    const after = other.requestStop(f.id, before.state.revision);
    expect(after.state.controlRevision).toBe(before.state.controlRevision + 1);
    expect(other.requestStop(f.id)).toEqual(after);
    expect(() => f.store.assertAdmitted(f.id, f.fence)).toThrow("stop");
  });
  test("durable newer revocation wins crash before mutable head update", () => {
    const f = setup();
    const revoked = {
      ...f.grant,
      revision: 2,
      revokedAt: new Date(f.now()).toISOString(),
      revocationReason: "user",
    };
    writeFileSync(join(f.store.directory(f.id), "grants", "2.json"), canonicalJson(revoked));
    const snapshot = new ExperimentStore(f.root).read(f.id);
    expect(snapshot.grant).toEqual(revoked);
    expect(snapshot.state.grantRevision).toBe(2);
    expect(() => f.store.assertAdmitted(f.id, f.fence, f.now())).toThrow("revoked");
    expect(f.store.appendGrant(f.id, revoked, 1)).toEqual(snapshot);
  });
  test("grant renewal appends immutable history and preserves start identity", () => {
    const f = setup();
    const snapshot = f.store.read(f.id);
    const renewal = grantFor(f.plan.planHash, f.now(), { revision: 2, maxRequests: 20 });
    const updated = f.store.appendGrant(f.id, renewal, snapshot.state.revision);
    expect(updated.grant?.revision).toBe(2);
    expect(readFileSync(join(f.store.directory(f.id), "grants", "1.json"), "utf8")).toBe(
      canonicalJson(f.grant),
    );
    expect(() =>
      f.store.appendGrant(f.id, { ...renewal, revision: 3, startOperationId: "different" }),
    ).toThrow("identity");
    expect(() => f.store.appendGrant(f.id, { ...renewal, revision: 2, maxRequests: 100 })).toThrow(
      "append",
    );
  });
  test("grant history gap and corrupted state fail closed", () => {
    const f = setup();
    writeFileSync(
      join(f.store.directory(f.id), "grants", "3.json"),
      canonicalJson({ ...f.grant, revision: 3 }),
    );
    expect(() => f.store.read(f.id)).toThrow("gap");
    rmSync(join(f.store.directory(f.id), "grants", "3.json"));
    writeFileSync(join(f.store.directory(f.id), "state.json"), "not json");
    expect(() => f.store.list()).toThrow("corrupt");
  });
  test("private state permissions", () => {
    const f = setup();
    if (process.platform !== "win32") {
      const path = join(f.store.directory(f.id), "state.json");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
});
