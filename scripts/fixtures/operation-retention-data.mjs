import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const retentionPlan = (intentId = "original", sessionId = "retention-session") => ({
  sessionId,
  intentId,
  service: "fixture",
  action: "write",
  channel: "link",
  account: "fixture-account",
  target: "fixture-target",
  parameters: { body: "synthetic private body" },
  postcondition: { body: "synthetic private body" },
});

/** Capacity metadata only: these are not thousands of actual provider operations. */
export function seedRetentionMetadata(root, count = 9000, options = {}) {
  const file = join(root, ".operations", "ledger.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  const original = Object.values(state.records)[0];
  if (!original || original.state !== "verified")
    throw new Error("Expected an actual verified receipt");
  const key = Buffer.from(
    options.decrypt ? options.decrypt(state.key) : state.key.replace(/^plain:/, ""),
    "hex",
  );
  if (key.length !== 32) throw new Error("Invalid synthetic capacity root key");
  for (let index = 1; index < count; index++) {
    const id = createHmac("sha256", key)
      .update(JSON.stringify(["intent", ["capacity-metadata", `seed-${index}`, null]]))
      .digest("hex");
    const record = {
      ...original,
      id,
      attemptId: randomUUID(),
      createdAt: original.createdAt + index,
    };
    delete record.recovery;
    delete record.ownerIncarnation;
    if (options.unknown) record.state = "unknown";
    state.records[id] = record;
  }
  if (options.unknown) state.records[original.id].state = "unknown";
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  key.fill(0);
  return { file, state, original };
}
