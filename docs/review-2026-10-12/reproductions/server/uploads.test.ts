import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { HubUploads } from "../../../../packages/server/src/hub/uploads.ts";
import { SessionDrafts } from "../../../../packages/web/app/drafts.ts";

async function accept(
  uploads: HubUploads,
  id: string,
  bytes = Buffer.from("hello"),
  mime = "text/plain",
) {
  const req = Readable.from([bytes]) as any;
  req.headers = {
    "content-length": String(bytes.length),
    "content-type": mime,
    "x-file-name": "example.txt",
  };
  const response = {
    status: 0,
    body: undefined as any,
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
  await uploads.accept(id, "owner", req, response as any, async () => true);
  return response;
}

test("review reproduction: discarding 16 attachments leaves no draft but blocks further uploads", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-review-uploads-"));
  const uploads = new HubUploads(join(root, "spools"), root);
  const drafts = new SessionDrafts();
  await uploads.ready();
  try {
    for (let i = 0; i < 16; i++) {
      const id = `upload-${String(i).padStart(8, "0")}`;
      const response = await accept(uploads, id);
      expect(response.status).toBe(201);
      drafts.addFile("session", response.body);
      drafts.removeFile("session", id);
    }
    expect(drafts.get("session").files).toHaveLength(0);
    expect(readdirSync(join(root, "spools"))).toHaveLength(16);
    const next = await accept(uploads, "upload-00000016");
    expect(next.status).toBe(429);
    console.info("Confirmed: 0 visible attachments; next upload rejected:", next.body.error);
  } finally {
    await uploads.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("review reproduction: an image above 10 MiB is reported uploaded then rejected only when sending", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-review-upload-size-"));
  const uploads = new HubUploads(join(root, "spools"), root);
  await uploads.ready();
  try {
    const response = await accept(
      uploads,
      "upload-00000001",
      Buffer.alloc(11 * 1024 * 1024),
      "image/png",
    );
    expect(response.status).toBe(201);
    await expect(uploads.prepare(["upload-00000001"], "owner", "session")).rejects.toThrow(
      "image attachment exceeds size limit",
    );
    console.info("Confirmed: accept returns 201 at 11 MiB while send cannot stage the same image.");
  } finally {
    await uploads.close();
    rmSync(root, { recursive: true, force: true });
  }
});
