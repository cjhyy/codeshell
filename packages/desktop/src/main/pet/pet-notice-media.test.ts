import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newNoticeRecordId } from "./pet-notice-ledger";
import { PetNoticeMediaStore } from "./pet-notice-media";
import { MAX_NOTICE_ATTACHMENT_BYTES, type NoticeMediaAttachment } from "./pet-notice-types";

let dir: string;
let root: string;
let logs: string[];
let store: PetNoticeMediaStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-notice-media-"));
  root = join(dir, "pet", "notice-media");
  logs = [];
  store = new PetNoticeMediaStore({ root, log: (event) => logs.push(event) });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, content: string | Buffer): Promise<NoticeMediaAttachment> {
  const path = join(dir, name);
  await writeFile(path, content);
  return {
    kind: name.endsWith(".png") ? "image" : "file",
    name,
    mimeType: name.endsWith(".png") ? "image/png" : "text/plain",
    size: Buffer.byteLength(content),
    path,
  };
}

const sha = (content: string) => createHash("sha256").update(content).digest("hex");

describe("PetNoticeMediaStore", () => {
  test("freezes each file into the record's folder with its size and digest", async () => {
    const id = newNoticeRecordId();
    const report = await file("report.txt", "v1 report");
    const image = await file("a.png", "png-bytes");
    const button = { text: "打开", url: "https://example.com/r" };
    const frozen = await store.freeze(id, { attachments: [report, image], button });
    expect(frozen).toEqual({
      attachments: [
        { ...report, path: join(root, id, "0.txt"), size: 9, sha256: sha("v1 report") },
        { ...image, path: join(root, id, "1.png"), size: 9, sha256: sha("png-bytes") },
      ],
      button,
    });
    // Later edits to the source never reach the notice.
    await writeFile(report.path, "v2 rewritten report");
    expect(await readFile(frozen!.attachments![0]!.path, "utf8")).toBe("v1 report");
  });

  test("the copy decides the size, and a name never escapes the folder", async () => {
    const id = newNoticeRecordId();
    const source = await file("notes.txt", "grown since the check");
    const frozen = await store.freeze(id, {
      attachments: [{ ...source, name: "../../evil", size: 3 }],
    });
    expect(frozen!.attachments![0]).toMatchObject({
      name: "../../evil",
      size: 21,
      path: join(root, id, "0"),
    });
  });

  test("any copy failure sends the notice text-only and leaves no folder", async () => {
    const id = newNoticeRecordId();
    const good = await file("ok.txt", "fine");
    const missing = { ...good, name: "gone.txt", path: join(dir, "gone.txt") };
    const button = { text: "打开", url: "https://example.com/r" };
    expect(await store.freeze(id, { attachments: [good, missing], button })).toEqual({ button });
    expect(await store.freeze(newNoticeRecordId(), { attachments: [missing] })).toBeUndefined();
    expect(logs).toEqual(["pet.notice.media_freeze_failed", "pet.notice.media_freeze_failed"]);
    expect(await readdir(root)).toEqual([]);
  });

  test("files over the closure limit and non-files are refused", async () => {
    const big = await file("big.txt", Buffer.alloc(MAX_NOTICE_ATTACHMENT_BYTES + 1));
    expect(await store.freeze(newNoticeRecordId(), { attachments: [big] })).toBeUndefined();
    const folder = { ...(await file("x.txt", "x")), path: dir };
    expect(await store.freeze(newNoticeRecordId(), { attachments: [folder] })).toBeUndefined();
    expect(await store.freeze("../escape", { attachments: [await file("y.txt", "y")] })).toBe(
      undefined,
    );
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });

  test("at most four files are frozen", async () => {
    const files = await Promise.all(
      [0, 1, 2, 3, 4].map((index) => file(`f${index}.txt`, `f${index}`)),
    );
    const frozen = await store.freeze(newNoticeRecordId(), { attachments: files });
    expect(frozen!.attachments).toHaveLength(4);
  });

  test("release deletes one folder; sweep keeps only what it is told to", async () => {
    const [a, b, c] = [newNoticeRecordId(), newNoticeRecordId(), newNoticeRecordId()];
    for (const id of [a, b, c]) await store.freeze(id, { attachments: [await file("r.txt", id)] });
    await mkdir(join(root, "not-a-record"));
    await store.release(a);
    expect((await readdir(root)).sort()).toEqual([b, c, "not-a-record"].sort());
    await store.sweep((id) => id === b);
    expect((await readdir(root)).sort()).toEqual([b, "not-a-record"].sort());
    // A missing root is not an error.
    await rm(root, { recursive: true, force: true });
    await store.sweep(() => false);
    expect(logs).toEqual([]);
  });
});
