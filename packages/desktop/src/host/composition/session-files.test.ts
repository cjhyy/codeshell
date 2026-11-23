import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeSessionFiles } from "./session-files.js";

test("revoked deletion leaves Session bytes intact; archiving and deleting retain legacy semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-session-files-owner-"));
  const dir = join(root, "owned");
  const state = join(dir, "state.json");
  const permit = () => new Int32Array(new SharedArrayBuffer(4));
  const command = (archivedAt?: number) => ({
    input: { sessionId: "owned", archivedAt },
    permit: permit(),
  });
  try {
    await mkdir(dir);
    await writeFile(
      state,
      JSON.stringify({ sessionId: "owned", cwd: root, startedAt: 1, title: "原会话" }),
    );
    await writeFile(join(root, "owned.jsonl"), "legacy");
    const stale = command();
    Atomics.store(stale.permit, 0, -1);
    await expect(changeSessionFiles(root, "sessions/deleteFiles", stale)).rejects.toThrow(
      /revoked/,
    );
    await changeSessionFiles(root, "sessions/archive", command(90));
    expect(JSON.parse(await readFile(state, "utf8"))).toMatchObject({
      title: "原会话",
      archivedAt: 90,
    });
    await changeSessionFiles(root, "sessions/archive", command());
    expect(JSON.parse(await readFile(state, "utf8")).archivedAt).toBeUndefined();
    await changeSessionFiles(root, "sessions/deleteFiles", command());
    expect(await Bun.file(state).exists()).toBe(false);
    expect(await Bun.file(join(root, "owned.jsonl")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
