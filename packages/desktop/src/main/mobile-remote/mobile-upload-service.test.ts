import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MAX_MOBILE_IMAGE_BYTES,
  MAX_MOBILE_UPLOAD_TICKETS_PER_DEVICE,
  MobileUploadService,
} from "./mobile-upload-service.js";

const roots: string[] = [];
const servers: Server[] = [];
const services: MobileUploadService[] = [];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serveUpload(service: MobileUploadService, uploadId: string): Promise<string> {
  const server = createServer((req, res) => void service.acceptPut(uploadId, req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

function makeService(now = () => Date.now()): MobileUploadService {
  const rootDir = mkdtempSync(join(tmpdir(), "cs-mobile-upload-"));
  roots.push(rootDir);
  const service = new MobileUploadService({ rootDir, now, cleanupIntervalMs: 0 });
  services.push(service);
  return service;
}

function fakePut(
  service: MobileUploadService,
  uploadId: string,
  mime = "image/png",
  contentLength?: number,
): {
  request: IncomingMessage;
  response: { status?: number; body?: string };
  done: Promise<void>;
} {
  const request = new PassThrough() as unknown as IncomingMessage;
  request.method = "PUT";
  request.headers = {
    "content-type": mime,
    ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
  };
  const responseState: { status?: number; body?: string } = {};
  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      responseState.status = status;
      this.headersSent = true;
      return this;
    },
    end(body?: string) {
      responseState.body = body;
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  return {
    request,
    response: responseState,
    done: service.acceptPut(uploadId, request, response),
  };
}

describe("MobileUploadService", () => {
  test("atomically claims a ticket, binds the claim to its owner, and finalizes the spool", async () => {
    const service = makeService();
    const bytes = PNG;
    const ticket = service.begin("device-a", {
      clientId: "client-1",
      name: "photo.png",
      mime: "image/png",
      size: bytes.byteLength,
    });
    const base = await serveUpload(service, ticket.uploadId);
    const response = await fetch(`${base}${ticket.putUrl}`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: bytes,
    });
    expect(response.status).toBe(201);

    expect(() => service.claim("device-b", ticket.uploadId)).toThrow(/device/i);
    const claimed = service.claim("device-a", ticket.uploadId);
    expect(claimed.size).toBe(bytes.byteLength);
    expect(claimed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(claimed.path)).toBe(true);
    expect(() => service.claim("device-a", ticket.uploadId)).toThrow(/claimed|ready/i);
    await expect(service.finalize("device-a", ticket.uploadId, "wrong-owner")).rejects.toThrow(
      /claim/i,
    );

    await service.finalize("device-a", ticket.uploadId, claimed.claimId);
    expect(existsSync(claimed.path)).toBe(false);
    expect(() => service.claim("device-a", ticket.uploadId)).toThrow(/upload/i);
  });

  test("rejects MIME/size mismatches, oversized declarations, and expired tickets", async () => {
    let now = 1000;
    const service = makeService(() => now);
    expect(() =>
      service.begin("device-a", {
        clientId: "too-big",
        name: "huge.png",
        mime: "image/png",
        size: MAX_MOBILE_IMAGE_BYTES + 1,
      }),
    ).toThrow(/size/i);

    const ticket = service.begin("device-a", {
      clientId: "client-1",
      name: "photo.png",
      mime: "image/png",
      size: 4,
    });
    const base = await serveUpload(service, ticket.uploadId);
    const wrongMime = await fetch(`${base}${ticket.putUrl}`, {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(4),
    });
    expect(wrongMime.status).toBe(415);

    now = ticket.expiresAt + 1;
    service.cleanupExpired();
    expect(() => service.claim("device-a", ticket.uploadId)).toThrow(/upload/i);
  });

  test("release permits bounded retry but one ticket cannot be claimed concurrently", async () => {
    const service = makeService();
    const ticket = service.begin("device-a", {
      clientId: "client-replay",
      name: "photo.png",
      mime: "image/png",
      size: 4,
    });
    const base = await serveUpload(service, ticket.uploadId);
    expect(
      (
        await fetch(`${base}${ticket.putUrl}`, {
          method: "PUT",
          headers: { "content-type": "image/png" },
          body: new Uint8Array(4),
        })
      ).status,
    ).toBe(201);

    const first = service.claim("device-a", ticket.uploadId);
    expect(() => service.claim("device-a", ticket.uploadId)).toThrow(/claimed|ready/i);
    await service.release("device-a", ticket.uploadId, first.claimId);
    const second = service.claim("device-a", ticket.uploadId);
    expect(second.claimId).not.toBe(first.claimId);
    await service.release("device-a", ticket.uploadId, second.claimId);
    const third = service.claim("device-a", ticket.uploadId);
    await service.release("device-a", ticket.uploadId, third.claimId);
    expect(() => service.claim("device-a", ticket.uploadId)).toThrow(/retry|upload/i);
  });

  test("caps outstanding tickets per authenticated device", () => {
    const service = makeService();
    for (let index = 0; index < MAX_MOBILE_UPLOAD_TICKETS_PER_DEVICE; index += 1) {
      service.begin("device-a", {
        clientId: `client-${index}`,
        name: `photo-${index}.png`,
        mime: "image/png",
        size: 4,
      });
    }
    expect(() =>
      service.begin("device-a", {
        clientId: "one-too-many",
        name: "photo.png",
        mime: "image/png",
        size: 4,
      }),
    ).toThrow(/too many/i);
    expect(() =>
      service.begin("device-b", {
        clientId: "other-device",
        name: "photo.png",
        mime: "image/png",
        size: 4,
      }),
    ).not.toThrow();
  });

  test("startup removes expired orphan .part/.upload files and dispose awaits recent cleanup", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "cs-mobile-upload-recovery-"));
    roots.push(rootDir);
    const oldPart = join(rootDir, "old-ticket.part");
    const oldUpload = join(rootDir, "old-ticket.upload");
    const recentUpload = join(rootDir, "recent-ticket.upload");
    writeFileSync(oldPart, "partial");
    writeFileSync(oldUpload, "ready");
    writeFileSync(recentUpload, "recent");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(oldPart, old, old);
    utimesSync(oldUpload, old, old);

    const service = new MobileUploadService({ rootDir, cleanupIntervalMs: 0 });
    services.push(service);
    await service.ready();
    expect(existsSync(oldPart)).toBe(false);
    expect(existsSync(oldUpload)).toBe(false);
    expect(existsSync(recentUpload)).toBe(true);

    await service.dispose();
    expect(existsSync(recentUpload)).toBe(false);
  });

  test("rejects chunked actual-size overflow/mismatch and removes interrupted parts", async () => {
    const service = makeService();
    const rootDir = roots.at(-1)!;
    const mismatchTicket = service.begin("device-a", {
      clientId: "mismatch",
      name: "photo.png",
      mime: "image/png",
      size: 4,
    });
    const mismatch = fakePut(service, mismatchTicket.uploadId);
    mismatch.request.end(new Uint8Array(5));
    await mismatch.done;
    expect(mismatch.response.status).toBe(400);

    const largeTicket = service.begin("device-a", {
      clientId: "large",
      name: "photo.png",
      mime: "image/png",
      size: MAX_MOBILE_IMAGE_BYTES,
    });
    const large = fakePut(service, largeTicket.uploadId);
    large.request.end(new Uint8Array(MAX_MOBILE_IMAGE_BYTES + 1));
    await large.done;
    expect(large.response.status).toBe(413);

    const interruptedTicket = service.begin("device-a", {
      clientId: "interrupted",
      name: "photo.png",
      mime: "image/png",
      size: 1024,
    });
    const interrupted = fakePut(service, interruptedTicket.uploadId);
    interrupted.request.write(new Uint8Array(8));
    interrupted.request.destroy();
    await interrupted.done;
    expect(readdirSync(rootDir).some((name) => name.endsWith(".part"))).toBe(false);
  });

  test("expires an upload during its pipeline and dispose waits for active unlink", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "cs-mobile-upload-deadline-"));
    roots.push(rootDir);
    const service = new MobileUploadService({
      rootDir,
      cleanupIntervalMs: 0,
      uploadTtlMs: 25,
    });
    services.push(service);
    const ticket = service.begin("device-a", {
      clientId: "slow",
      name: "photo.png",
      mime: "image/png",
      size: 1024,
    });
    const slow = fakePut(service, ticket.uploadId);
    slow.request.write(new Uint8Array(8));
    await Bun.sleep(50);
    await slow.done;
    expect(slow.response.status).toBe(408);
    expect(() => service.claim("device-a", ticket.uploadId)).toThrow(/upload|expired/i);
    expect(readdirSync(rootDir).some((name) => name.endsWith(".part"))).toBe(false);

    const second = service.begin("device-a", {
      clientId: "dispose",
      name: "photo.png",
      mime: "image/png",
      size: 1024,
    });
    const active = fakePut(service, second.uploadId);
    active.request.write(new Uint8Array(8));
    await Bun.sleep(5);
    await service.dispose();
    await active.done;
    expect(readdirSync(rootDir).filter((name) => /\.(part|upload)$/.test(name))).toEqual([]);
  });
});
