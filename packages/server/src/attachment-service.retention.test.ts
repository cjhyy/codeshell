import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";

if (!process.env.CODE_SHELL_TEST_HOME) throw new Error("Use the guarded test runner");

const native = createRequire(import.meta.url)("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  native[name] = () => {
    throw new Error(`Native attachment test transport denied: ${name}`);
  };
}
process.kill = () => {
  throw new Error("Native attachment test signal denied");
};
globalThis.fetch = (() => {
  throw new Error("Attachment retention test network denied");
}) as typeof fetch;
syncBuiltinESMExports();

const {
  DRAFT_ATTACHMENT_TTL_MS,
  SENT_ATTACHMENT_TTL_MS,
  cleanupAttachments,
  listRecentAttachments,
  markAttachmentsSent,
  stageImageDataUrl,
} = await import("./attachment-service");

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const owned = new Set<string>();

function workspace(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-attachment-retention-")));
  owned.add(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of owned) rmSync(cwd, { recursive: true, force: true });
  owned.clear();
});

async function stage(cwd: string, sessionId: string, name: string) {
  return stageImageDataUrl({ cwd, sessionId, name, dataUrl: png, origin: "paste" });
}

for (const sentFirst of [false, true]) {
  test(`expired draft retains a shared sent image (sent staged first: ${sentFirst})`, async () => {
    const cwd = workspace();
    const first = await stage(cwd, "shared-session", "first.png");
    const second = await stage(cwd, "shared-session", "second.png");
    const sent = sentFirst ? first : second;
    const draft = sentFirst ? second : first;
    await markAttachmentsSent(cwd, "shared-session", [sent]);
    const control = await stage(cwd, "control-session", "control.png");
    await markAttachmentsSent(cwd, "control-session", [control]);

    expect(draft.id).not.toBe(sent.id);
    expect(draft.absPath).toBe(sent.absPath);
    expect(control.absPath).not.toBe(sent.absPath);
    const now = Math.max(first.createdAt, second.createdAt) + DRAFT_ATTACHMENT_TTL_MS + 1_000;
    expect(now - sent.createdAt).toBeLessThan(SENT_ATTACHMENT_TTL_MS);
    const result = await cleanupAttachments({ cwd, now });

    expect(result.removed).not.toContain(sent.absPath);
    expect(existsSync(sent.absPath)).toBe(true);
    expect(
      (await listRecentAttachments({ cwd, sessionId: "shared-session" })).map((x) => x.id),
    ).toEqual([sent.id]);
    expect(existsSync(control.absPath)).toBe(true);
    const manifest = readFileSync(
      join(cwd, ".code-shell", "attachments", "shared-session", "manifest.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(manifest.filter((row) => row.event === "cleanup").map((row) => row.id)).toEqual([
      draft.id,
    ]);
  });
}

test("all expired references remove the shared file once and retire every expired id", async () => {
  const cwd = workspace();
  const first = await stage(cwd, "shared-session", "first.png");
  const second = await stage(cwd, "shared-session", "second.png");
  await markAttachmentsSent(cwd, "shared-session", [second]);
  expect(first.absPath).toBe(second.absPath);

  const now = Date.now() + SENT_ATTACHMENT_TTL_MS + 1_000;
  const result = await cleanupAttachments({ cwd, now });
  expect(result.removed).toEqual([first.absPath]);
  expect(existsSync(first.absPath)).toBe(false);
  expect(await listRecentAttachments({ cwd, sessionId: "shared-session" })).toEqual([]);
  const manifest = readFileSync(
    join(cwd, ".code-shell", "attachments", "shared-session", "manifest.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    manifest
      .filter((row) => row.event === "cleanup")
      .map((row) => row.id)
      .sort(),
  ).toEqual([first.id, second.id].sort());
  expect(await cleanupAttachments({ cwd, now })).toEqual({ removed: [], sessionsRemoved: [] });
});

for (const createdAt of [0, undefined]) {
  test(`a shared reference with uncertain creation time protects its image (${createdAt})`, async () => {
    const cwd = workspace();
    const expired = await stage(cwd, "shared-session", "expired.png");
    const uncertain = await stage(cwd, "shared-session", "uncertain.png");
    expect(expired.absPath).toBe(uncertain.absPath);
    const manifest = join(cwd, ".code-shell", "attachments", "shared-session", "manifest.jsonl");
    const records = readFileSync(manifest, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const record = JSON.parse(line);
        return record.id === uncertain.id ? { ...record, createdAt } : record;
      });
    // Model a supported legacy record with zero/missing age, without changing Date.
    writeFileSync(manifest, records.map((record) => JSON.stringify(record) + "\n").join(""));

    const result = await cleanupAttachments({
      cwd,
      now: expired.createdAt + DRAFT_ATTACHMENT_TTL_MS + 1_000,
    });
    expect(result.removed).toEqual([]);
    expect(existsSync(uncertain.absPath)).toBe(true);
    const final = readFileSync(manifest, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(final.filter((row) => row.event === "cleanup").map((row) => row.id)).toEqual([
      expired.id,
    ]);
  });
}
