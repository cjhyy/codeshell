import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RegisterPetFollowUpInput } from "@cjhyy/code-shell-pet";
import { PetRegisteredFollowUpStore } from "./pet-registered-follow-up-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: ConstructorParameters<typeof PetRegisteredFollowUpStore>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "pet-followup-"));
  roots.push(root);
  const path = join(root, "registered.json");
  let now = 1_000;
  const store = new PetRegisteredFollowUpStore(path, { now: () => now, ...options });
  const input: RegisterPetFollowUpInput = {
    operationKey: "turn-1:follow-up",
    title: "提交材料",
    text: "提醒我提交材料",
    wakeAt: 5_000,
    timezone: "Asia/Singapore",
    intent: "remind",
  };
  return {
    path,
    store,
    input,
    setNow: (at: number) => {
      now = at;
    },
  };
}

describe("PetRegisteredFollowUpStore", () => {
  test("registers a session-free obligation durably and notifies only after commit", async () => {
    const f = await fixture();
    let changes = 0;
    f.store.subscribe(() => {
      changes += 1;
      expect(f.store.list()).toHaveLength(1);
    });
    const row = await f.store.register(f.input);
    expect(row).toMatchObject({
      revision: 1,
      status: "open",
      intent: "remind",
      missedPolicy: "fire-once",
      catchUpUntil: 5_000 + 86_400_000,
      wake: { revision: 1, status: "scheduled" },
    });
    expect(row.sourceSessionId).toBeUndefined();
    const restored = new PetRegisteredFollowUpStore(f.path);
    await restored.load();
    expect(restored.get(row.id)).toEqual(row);
    expect(changes).toBe(1);
    await f.store.register(f.input);
    expect(changes).toBe(1);
  });

  test("replaying the original registration never undoes a later reschedule or cancellation", async () => {
    const f = await fixture();
    const row = await f.store.register(f.input);
    const edited = await f.store.reschedule(row.id, 1, {
      wakeAt: 6_000,
      timezone: "UTC",
      missedPolicy: "skip",
    });
    expect(await f.store.register(f.input)).toEqual(edited);
    const cancelled = await f.store.cancel(row.id, 2);
    const restored = new PetRegisteredFollowUpStore(f.path);
    await restored.load();
    expect(await restored.register(f.input)).toEqual(cancelled);
    expect(restored.list()).toHaveLength(1);
    await expect(restored.register({ ...f.input, text: "different intent" })).rejects.toThrow(
      "different registration",
    );
    expect(restored.findByOperationKey(f.input.operationKey)?.status).toBe("cancelled");
  });

  test("requires exact source identity for resume and keeps ordinary reminders free of execution identity", async () => {
    const f = await fixture();
    await expect(f.store.register({ ...f.input, intent: "resume" })).rejects.toThrow("invalid");
    await expect(f.store.register({ ...f.input, sourceSessionId: "session-a" })).rejects.toThrow(
      "invalid",
    );
    await expect(
      f.store.register({ ...f.input, intent: "resume", sourceSessionId: " session-a" }),
    ).rejects.toThrow("invalid");
    const row = await f.store.register({
      ...f.input,
      intent: "resume",
      sourceSessionId: "session-a",
      taskId: "task-a",
    });
    expect(row.sourceSessionId).toBe("session-a");
  });

  test("rejects invalid times, timezone and catch-up policy without saving a record", async () => {
    const f = await fixture();
    for (const patch of [
      { wakeAt: 999 },
      { wakeAt: NaN },
      { timezone: "invalid/zone" },
      { catchUpUntil: 4_999 },
      { missedPolicy: "guess" },
    ]) {
      await expect(
        f.store.register({ ...f.input, ...patch } as RegisterPetFollowUpInput),
      ).rejects.toThrow();
    }
    expect(f.store.list()).toEqual([]);
  });

  test("claims a due revision only once even under concurrent callbacks", async () => {
    const f = await fixture();
    const row = await f.store.register(f.input);
    expect(await f.store.claimWake(row.id, 1)).toBeUndefined();
    f.setNow(5_000);
    const claims = await Promise.all([f.store.claimWake(row.id, 1), f.store.claimWake(row.id, 1)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(f.store.reschedule(row.id, 1, { wakeAt: 6_000, timezone: "UTC" })).rejects.toThrow(
      "正在唤醒",
    );
    await expect(f.store.cancel(row.id, 1)).rejects.toThrow("正在唤醒");
    await expect(f.store.handle(row.id, 1, "dismiss")).rejects.toThrow("正在唤醒");
    const outcome = await f.store.completeWake(row.id, 1, {
      status: "notified",
      detail: "平台已接受",
    });
    expect(outcome?.wake).toMatchObject({
      status: "notified",
      claimedAt: 5_000,
      completedAt: 5_000,
      detail: "平台已接受",
    });
    expect(await f.store.completeWake(row.id, 1, { status: "notified" })).toBeUndefined();
    expect(await f.store.claimWake(row.id, 1)).toBeUndefined();
  });

  test("crash recovery preserves uncertainty rather than replaying a possibly sent message", async () => {
    const f = await fixture();
    const row = await f.store.register(f.input);
    f.setNow(5_000);
    await f.store.claimWake(row.id, 1);
    const restored = new PetRegisteredFollowUpStore(f.path, { now: () => 6_000 });
    await restored.load();
    expect(await restored.claimWake(row.id, 1)).toBeUndefined();
    expect(await restored.recoverClaims()).toBe(1);
    expect(restored.get(row.id)?.wake.status).toBe("unknown");
    expect(await restored.claimWake(row.id, 1)).toBeUndefined();
    expect(await restored.recoverClaims()).toBe(0);
    // An explicit edit is a new authorization with a new revision.
    const edited = await restored.reschedule(row.id, 1, { wakeAt: 7_000, timezone: "UTC" });
    expect(edited).toMatchObject({ revision: 2, wake: { status: "scheduled", revision: 2 } });
  });

  test("cancel and reschedule fence stale callbacks and stale UI mutations", async () => {
    const f = await fixture();
    const row = await f.store.register(f.input);
    await f.store.reschedule(row.id, 1, { wakeAt: 6_000, timezone: "UTC" });
    f.setNow(6_000);
    expect(await f.store.claimWake(row.id, 1)).toBeUndefined();
    await expect(f.store.cancel(row.id, 1)).rejects.toThrow("版本");
    await f.store.cancel(row.id, 2);
    expect(await f.store.claimWake(row.id, 2)).toBeUndefined();
    expect(await f.store.completeWake(row.id, 2, { status: "notified" })).toBeUndefined();
  });

  test("failed atomic replacement cannot announce or expose an uncommitted edit", async () => {
    let fail = false;
    const f = await fixture({
      replaceFile: async (temporary, target) => {
        if (fail) throw new Error("disk write failed");
        await (await import("node:fs/promises")).rename(temporary, target);
      },
    });
    const row = await f.store.register(f.input);
    let changes = 0;
    f.store.subscribe(() => {
      changes += 1;
    });
    fail = true;
    await expect(f.store.cancel(row.id, 1)).rejects.toThrow("disk write failed");
    expect(f.store.get(row.id)).toEqual(row);
    expect(changes).toBe(0);
    const restored = new PetRegisteredFollowUpStore(f.path);
    await restored.load();
    expect(restored.get(row.id)).toEqual(row);
  });

  test("rejects corrupt, duplicate, unsafe and unknown-field storage without overwriting it", async () => {
    const f = await fixture();
    const row = await f.store.register(f.input);
    for (const content of [
      "{bad",
      JSON.stringify({ version: 1, entries: [row, row] }),
      JSON.stringify({ version: 1, entries: [{ ...row, privilege: "full" }] }),
      JSON.stringify({ version: 2, entries: [] }),
    ]) {
      await writeFile(f.path, content, { mode: 0o600 });
      const store = new PetRegisteredFollowUpStore(f.path);
      await expect(store.register(f.input)).rejects.toThrow();
      expect(await readFile(f.path, "utf8")).toBe(content);
    }
    await writeFile(f.path, JSON.stringify({ version: 1, entries: [row] }));
    if (process.platform !== "win32") {
      await chmod(f.path, 0o644);
      await expect(new PetRegisteredFollowUpStore(f.path).load()).rejects.toThrow("unsafe");
      await chmod(f.path, 0o600);
    }
    const link = `${f.path}.link`;
    await symlink(f.path, link);
    await expect(new PetRegisteredFollowUpStore(link).load()).rejects.toThrow("unsafe");
  });

  test("snapshot callers cannot mutate canonical records or outcome identity", async () => {
    const f = await fixture();
    const row = await f.store.register(f.input);
    row.text = "tampered";
    f.store.list()[0]!.wake.status = "notified";
    expect(f.store.get(row.id)?.text).toBe(f.input.text);
    f.setNow(5_000);
    await f.store.claimWake(row.id, 1);
    await expect(
      f.store.completeWake(row.id, 1, { status: "notified", revision: 2 } as never),
    ).rejects.toThrow("invalid");
    expect(f.store.get(row.id)?.wake.status).toBe("claimed");
  });
});
