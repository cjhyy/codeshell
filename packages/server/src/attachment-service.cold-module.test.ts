import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.CODE_SHELL_TEST_HOME) throw new Error("Use the guarded test runner");

const native = createRequire(import.meta.url)("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  native[name] = () => {
    throw new Error(`Native cold-module attachment test transport denied: ${name}`);
  };
}
process.kill = () => {
  throw new Error("Native cold-module attachment test signal denied");
};
globalThis.fetch = (() => {
  throw new Error("Cold-module attachment test network denied");
}) as typeof fetch;
syncBuiltinESMExports();

const owned = new Set<string>();
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

afterEach(() => {
  for (const root of owned) rmSync(root, { recursive: true, force: true });
  owned.clear();
});

async function coldModules() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-attachment-cold-module-")));
  owned.add(root);
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const serviceBytes = readFileSync(new URL("./attachment-service.ts", import.meta.url));
  const imageBytes = readFileSync(new URL("./image-byte-probe.ts", import.meta.url));

  const modules = [];
  for (const label of ["first-lifetime", "second-lifetime"]) {
    const moduleDirectory = join(root, label);
    mkdirSync(moduleDirectory);
    const servicePath = join(moduleDirectory, "attachment-service.ts");
    writeFileSync(servicePath, serviceBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(join(moduleDirectory, "image-byte-probe.ts"), imageBytes, {
      flag: "wx",
      mode: 0o600,
    });
    // Distinct file URLs give the actual, byte-identical service separate module state.
    modules.push(await import(pathToFileURL(servicePath).href));
  }
  return { cwd, first: modules[0]!, second: modules[1]! };
}

const input = (cwd: string) => ({
  cwd,
  sessionId: "persisted-session",
  name: "same-image.png",
  dataUrl: png,
  origin: "paste" as const,
});

test("a cold attachment service does not reuse a persisted sent image id", async () => {
  const { cwd, first, second } = await coldModules();
  expect(first.stageImageDataUrl).not.toBe(second.stageImageDataUrl);
  const sent = await first.stageImageDataUrl(input(cwd));
  await first.markAttachmentsSent(cwd, sent.sessionId, [sent]);
  const staged = await second.stageImageDataUrl(input(cwd));

  expect(staged.absPath).toBe(sent.absPath);
  expect(staged.id).not.toBe(sent.id);
});

test("a draft from a cold service cannot expire an earlier sent image reference", async () => {
  const { cwd, first, second } = await coldModules();
  expect(first.stageImageDataUrl).not.toBe(second.stageImageDataUrl);
  const sent = await first.stageImageDataUrl(input(cwd));
  await first.markAttachmentsSent(cwd, sent.sessionId, [sent]);
  const originalBytes = readFileSync(sent.absPath);
  const staged = await second.stageImageDataUrl(input(cwd));
  expect(staged.absPath).toBe(sent.absPath);

  const now = Math.max(sent.createdAt, staged.createdAt) + second.DRAFT_ATTACHMENT_TTL_MS + 1_000;
  expect(now - sent.createdAt).toBeLessThan(second.SENT_ATTACHMENT_TTL_MS);
  const result = await second.cleanupAttachments({ cwd, now });

  expect(result.removed).toEqual([]);
  expect(existsSync(sent.absPath)).toBe(true);
  expect(readFileSync(sent.absPath)).toEqual(originalBytes);
  expect(
    (await second.listRecentAttachments({ cwd, sessionId: sent.sessionId })).map((x) => x.id),
  ).toEqual([sent.id]);
  const records = readFileSync(
    join(cwd, ".code-shell", "attachments", sent.sessionId, "manifest.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.filter((row) => row.event === "cleanup").map((row) => row.id)).toEqual([
    staged.id,
  ]);
});

const fileInput = (cwd: string) => ({
  cwd,
  sessionId: "persisted-file-session",
  name: "same-file.txt",
  mime: "text/plain",
  bytes: Buffer.from("same persisted file bytes\n"),
  origin: "picker" as const,
});

test("a cold attachment service does not reuse a persisted sent file id", async () => {
  const { cwd, first, second } = await coldModules();
  expect(first.stageFileBytes).not.toBe(second.stageFileBytes);
  const sent = await first.stageFileBytes(fileInput(cwd));
  await first.markAttachmentsSent(cwd, sent.sessionId, [sent]);
  const staged = await second.stageFileBytes(fileInput(cwd));

  expect(staged.absPath).toBe(sent.absPath);
  expect(staged.id).not.toBe(sent.id);
});

test("a file draft from a cold service cannot expire an earlier sent file reference", async () => {
  const { cwd, first, second } = await coldModules();
  expect(first.stageFileBytes).not.toBe(second.stageFileBytes);
  const sent = await first.stageFileBytes(fileInput(cwd));
  await first.markAttachmentsSent(cwd, sent.sessionId, [sent]);
  const originalBytes = readFileSync(sent.absPath);
  const staged = await second.stageFileBytes(fileInput(cwd));
  expect(staged.absPath).toBe(sent.absPath);

  const now = Math.max(sent.createdAt, staged.createdAt) + second.DRAFT_ATTACHMENT_TTL_MS + 1_000;
  expect(now - sent.createdAt).toBeLessThan(second.SENT_ATTACHMENT_TTL_MS);
  const result = await second.cleanupAttachments({ cwd, now });

  expect(result.removed).toEqual([]);
  expect(existsSync(sent.absPath)).toBe(true);
  expect(readFileSync(sent.absPath)).toEqual(originalBytes);
  const recent = await second.listRecentAttachments({ cwd, sessionId: sent.sessionId });
  expect(recent.some((entry) => entry.id === sent.id)).toBe(true);
  const records = readFileSync(
    join(cwd, ".code-shell", "attachments", sent.sessionId, "manifest.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.filter((row) => row.event === "cleanup").map((row) => row.id)).toEqual([
    staged.id,
  ]);
});
