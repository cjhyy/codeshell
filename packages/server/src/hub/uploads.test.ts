import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { HubUploads } from "./uploads.js";

const roots: string[] = [];
const services: HubUploads[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(root?: string) {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), "hub-uploads-")));
  if (!roots.includes(root)) roots.push(root);
  const uploads = new HubUploads(join(root, "spools"), root);
  services.push(uploads);
  await uploads.ready();
  return { root, spools: join(root, "spools"), uploads };
}

async function put(
  uploads: HubUploads,
  id: string,
  options: { bytes?: Buffer; mime?: string; owner?: string } = {},
) {
  const bytes = options.bytes ?? Buffer.from("hello");
  const req = Readable.from([bytes]) as unknown as IncomingMessage;
  req.headers = {
    "content-length": String(bytes.length),
    "content-type": options.mime ?? "text/plain",
    "x-file-name": "example.txt",
  };
  const res = {
    status: 0,
    body: undefined as { error?: string } | undefined,
    writableEnded: false,
    destroyed: false,
    writeHead(status: number) {
      this.status = status;
    },
    end(body: string) {
      this.body = JSON.parse(body);
      this.writableEnded = true;
    },
  };
  await uploads.accept(
    id,
    options.owner ?? "owner",
    req,
    res as unknown as ServerResponse,
    async () => true,
  );
  return res;
}

/** Spooled upload files below the managed root, whichever instance owns them. */
function spooled(spools: string): string[] {
  return readdirSync(spools, { recursive: true, encoding: "utf8" }).filter((name) =>
    name.endsWith(".upload"),
  );
}

describe("HubUploads", () => {
  test("discarding a draft attachment releases its quota and spool", async () => {
    const { spools, uploads } = await fixture();
    for (let index = 0; index < 16; index++) {
      const id = `upload-${String(index).padStart(8, "0")}`;
      expect((await put(uploads, id)).status).toBe(201);
    }
    expect((await put(uploads, "upload-00000016")).status).toBe(429);
    // Another device cannot discard this owner's uploads.
    expect(await uploads.discard("upload-00000000", "intruder")).toBe(false);
    for (let index = 0; index < 16; index++) {
      expect(await uploads.discard(`upload-${String(index).padStart(8, "0")}`, "owner")).toBe(true);
    }
    expect(spooled(spools)).toEqual([]);
    expect((await put(uploads, "upload-00000016")).status).toBe(201);
  });

  test("an upload claimed by a send in progress cannot be discarded", async () => {
    const { uploads } = await fixture();
    expect((await put(uploads, "upload-claimed")).status).toBe(201);
    const prepared = await uploads.prepare(["upload-claimed"], "owner", "session");
    expect(await uploads.discard("upload-claimed", "owner")).toBe(false);
    prepared.release();
    expect(await uploads.discard("upload-claimed", "owner")).toBe(true);
    await expect(uploads.prepare(["upload-claimed"], "owner", "session")).rejects.toThrow(
      "upload not found or expired",
    );
  });

  test("images the send path cannot stage are rejected at upload time", async () => {
    const { spools, uploads } = await fixture();
    const oversized = await put(uploads, "upload-big-image", {
      bytes: Buffer.alloc(11 * 1024 * 1024),
      mime: "image/png",
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body?.error).toContain("10 MiB");
    const unsupported = await put(uploads, "upload-heic-image", { mime: "image/heic" });
    expect(unsupported.status).toBe(415);
    expect(spooled(spools)).toEqual([]);
    // Non-image files keep the general 20 MiB limit.
    expect(
      (
        await put(uploads, "upload-big-file", {
          bytes: Buffer.alloc(11 * 1024 * 1024),
          mime: "application/pdf",
        })
      ).status,
    ).toBe(201);
  });

  test("a second instance sharing the data directory keeps the live instance's uploads", async () => {
    const first = await fixture();
    expect((await put(first.uploads, "upload-live-one")).status).toBe(201);
    // A duplicate launch reaches ready() before failing to bind its port.
    const second = await fixture(first.root);
    await second.uploads.close();
    expect(spooled(first.spools)).toHaveLength(1);
    const prepared = await first.uploads.prepare(["upload-live-one"], "owner", "session");
    expect(prepared.attachments).toHaveLength(1);
    await prepared.commit();
  });

  test("spools abandoned by a crashed instance or an older Host are reclaimed", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-uploads-")));
    roots.push(root);
    const spools = join(root, "spools");
    const abandoned = join(spools, "instance-00000000-0000-4000-8000-000000000000");
    mkdirSync(abandoned, { recursive: true });
    writeFileSync(join(abandoned, "11111111-1111-4111-8111-111111111111.upload"), "lost");
    // An older Host spooled directly into the root; only expired files are provably unused.
    const expired = join(spools, "22222222-2222-4222-8222-222222222222.upload");
    writeFileSync(expired, "legacy");
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(expired, longAgo, longAgo);
    const recent = "33333333-3333-4333-8333-333333333333.upload";
    writeFileSync(join(spools, recent), "maybe live");
    const { uploads } = await fixture(root);
    expect(spooled(spools)).toEqual([recent]);
    expect((await put(uploads, "upload-after-reclaim")).status).toBe(201);
    expect(spooled(spools)).toHaveLength(2);
  });
});
