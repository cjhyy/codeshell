import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StoredMimiRecords } from "./mimi-records.js";
import type { MimiRecordCall } from "../../shared/mimi-records.js";

test("Mimi records reject withdrawn writes at the file replacement and keep concurrent updates across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-mimi-records-"));
  const permit = () => new Int32Array(new SharedArrayBuffer(4));
  try {
    const owner = new StoredMimiRecords(dir);
    const run = (call: MimiRecordCall, p = permit()) => owner.run({ call, permit: p });
    const lost = permit();
    Atomics.store(lost, 0, -1);
    await expect(run({ action: "remember", args: ["revoked", "user"] }, lost)).rejects.toThrow(
      "revoked",
    );
    await expect(readFile(join(dir, "memories.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await Promise.all(["a", "b"].map((text) => run({ action: "remember", args: [text, "user"] })));
    const cold = new StoredMimiRecords(dir);
    expect(
      (await cold.run({ call: { action: "memoryList", args: [] }, permit: permit() })).result,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "a" }),
        expect.objectContaining({ text: "b" }),
      ]),
    );
    const entry = {
      segmentId: "seg-a",
      title: "Journal",
      summary: "synthetic",
      startedAt: 2,
      endedAt: 5,
      messageCount: 1,
      range: { start: 0, end: 1 },
    };
    await expect(run({ action: "record", args: [entry] }, lost)).rejects.toThrow("revoked");
    await expect(readFile(join(dir, "journal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
