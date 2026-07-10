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
  test("streams a ticket upload, binds it to the device, and consumes the spool", async () => {
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

    expect(() => service.resolve("device-b", ticket.uploadId)).toThrow(/device/i);
    const ready = service.resolve("device-a", ticket.uploadId);
    expect(ready.size).toBe(bytes.byteLength);
    expect(ready.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(ready.path)).toBe(true);

    await service.consume("device-a", ticket.uploadId);
    expect(existsSync(ready.path)).toBe(false);
    expect(() => service.resolve("device-a", ticket.uploadId)).toThrow(/upload/i);
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
    expect(() => service.resolve("device-a", ticket.uploadId)).toThrow(/upload/i);
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
