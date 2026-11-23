import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoredMimiRules } from "./mimi-rules.js";
import type { MimiRuleCall } from "../../shared/mimi-rules.js";
import type { NoticeRule } from "../../main/pet/pet-rule-store.js";

test("a revoked document cannot change the owner's rule; competing editors claim its version only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mimi-rule-owner-"));
  const permit = () => new Int32Array(new SharedArrayBuffer(4));
  const run = (owner: StoredMimiRules, call: MimiRuleCall, word = permit()) =>
    owner.run({ call, permit: word });
  try {
    const first = new StoredMimiRules(directory);
    const original = await run(first, { method: "systemRule", args: ["all-sessions"] });
    if (!original.ok) throw Error(original.code);
    const version = (original.value as NoticeRule).version;
    const edits: MimiRuleCall = {
      method: "setSystemRule",
      args: ["all-sessions", { channel: "desktop", state: "active" }, version],
    };
    const revoked = permit();
    Atomics.store(revoked, 0, -1);
    await expect(run(first, edits, revoked)).rejects.toThrow("expired");
    const [left, right] = await Promise.all([run(first, edits), run(first, edits)]);
    expect([left, right].filter((row) => row.ok)).toHaveLength(1);
    expect([left, right]).toContainEqual({ ok: false, code: "version_conflict" });
    expect(
      await run(new StoredMimiRules(directory), { method: "systemRule", args: ["all-sessions"] }),
    ).toMatchObject({
      ok: true,
      value: { channel: "desktop", state: "active", version: version + 1 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
