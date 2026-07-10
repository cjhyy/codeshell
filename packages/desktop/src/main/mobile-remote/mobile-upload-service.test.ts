import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_MOBILE_IMAGE_BYTES,
  MAX_MOBILE_UPLOAD_TICKETS_PER_DEVICE,
  MobileUploadService,
} from "./mobile-upload-service.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
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
  return new MobileUploadService({ rootDir, now, cleanupIntervalMs: 0 });
}

describe("MobileUploadService", () => {
  test("atomically claims a ticket, binds the claim to its owner, and finalizes the spool", async () => {
    const service = makeService();
    const bytes = new Uint8Array([1, 2, 3, 4]);
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
});
