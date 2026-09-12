import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PanelMediaService } from "./panel-media-service.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panel-asset-read-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const scope = { appId: "generic-media-panel", projectPath: join(root, "project") };
  let authorized = true;
  const service = new PanelMediaService({
    rootDirectory: join(root, "store"),
    isScopeAuthorized: () => authorized,
  });
  cleanup.push(() => service.shutdown());
  const data = Buffer.from(Array.from({ length: 70003 }, (_, index) => (index * 71) % 256));
  const source = join(root, "media.wav");
  await writeFile(source, data);
  const asset = await service.library.importFile(scope, source);
  const read = (input: Record<string, unknown>) =>
    service.dispatch(scope, "media.assets.read", input) as Promise<{
      assetId: string;
      offset: number;
      totalBytes: number;
      mimeType: string;
      dataBase64: string;
      eof: boolean;
    }>;
  return {
    root,
    scope,
    service,
    asset,
    data,
    read,
    revoke: () => {
      authorized = false;
    },
  };
}

test("managed asset chunks are discoverable, bounded and reconstruct exact bytes without exposing paths", async () => {
  const f = await fixture();
  await f.service.initialize();
  // Capability discovery is independent of optional Panel runtimes.
  const status = (await f.service.dispatch(f.scope, "media.status", {})) as any;
  expect(status.assetRead).toEqual({ available: true, maxChunkBytes: 32768 });
  const buffers: Buffer[] = [];
  for (let offset = 0; offset < f.data.length; offset += 32768) {
    const chunk = await f.read({ assetId: f.asset.id, offset, length: 32768 });
    const bytes = Buffer.from(chunk.dataBase64, "base64");
    expect(bytes.length).toBe(Math.min(32768, f.data.length - offset));
    expect(chunk).toMatchObject({
      assetId: f.asset.id,
      offset,
      totalBytes: f.data.length,
      mimeType: "audio/wav",
      eof: offset + bytes.length === f.data.length,
    });
    expect(Object.keys(chunk).sort()).toEqual([
      "assetId",
      "dataBase64",
      "eof",
      "mimeType",
      "offset",
      "totalBytes",
    ]);
    expect(JSON.stringify(chunk)).not.toContain(f.root);
    expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(45000);
    buffers.push(bytes);
  }
  expect(Buffer.concat(buffers)).toEqual(f.data);
  const eof = await f.read({ assetId: f.asset.id, offset: f.data.length, length: 1 });
  expect(eof.dataBase64).toBe("");
  expect(eof.eof).toBe(true);
  const finalByte = await f.read({ assetId: f.asset.id, offset: f.data.length - 1, length: 32768 });
  expect(Buffer.from(finalByte.dataBase64, "base64")).toEqual(f.data.subarray(-1));
  expect(await f.service.jobs.list(f.scope)).toHaveLength(0);
});

test("chunk reads reject missing, invalid and oversized ranges and unknown fields", async () => {
  const f = await fixture();
  const input = { assetId: f.asset.id, offset: 0, length: 1 };
  for (const changes of [
    { offset: undefined },
    { length: undefined },
    { offset: -1 },
    { offset: 0.5 },
    { offset: NaN },
    { offset: Infinity },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { offset: f.data.length + 1 },
    { length: 0 },
    { length: -1 },
    { length: 32769 },
    { length: 1.5 },
    { length: Infinity },
    { path: "/private/file" },
    { projectPath: "/foreign" },
    { assetId: "/private/file" },
  ])
    await expect(f.read({ ...input, ...changes })).rejects.toThrow();
  expect(Buffer.from((await f.read(input)).dataBase64, "base64")).toEqual(f.data.subarray(0, 1));
});

test("chunk reads enforce both app and workspace binding and reject revocation during a read", async () => {
  const f = await fixture();
  const input = { assetId: f.asset.id, offset: 0, length: 64 };
  for (const scope of [
    { ...f.scope, appId: "other-panel" },
    { ...f.scope, projectPath: "/other-workspace" },
  ]) {
    try {
      await f.service.dispatch(scope, "media.assets.read", input);
      throw new Error("Foreign asset unexpectedly returned");
    } catch (error) {
      expect((error as Error).message).toBe("无法读取受管素材，请确认素材仍可用后重试");
      expect((error as Error).message).not.toContain(f.root);
    }
  }
  const original = f.service.library.openRead.bind(f.service.library);
  f.service.library.openRead = async (...args) => {
    const result = await original(...args);
    f.revoke();
    return result;
  };
  await expect(f.read(input)).rejects.toThrow("revoked");
  await expect(f.read(input)).rejects.toThrow("revoked");
});

test("missing or replaced managed content cannot leak filesystem errors or return partial bytes", async () => {
  for (const replacement of ["missing", "symlink", "truncated"] as const) {
    const f = await fixture();
    const path = await f.service.library.resolvePath(f.scope, f.asset.id);
    await rm(path);
    if (replacement === "symlink") {
      const external = join(f.root, "private.wav");
      await writeFile(external, f.data);
      await symlink(external, path);
    }
    if (replacement === "truncated") await writeFile(path, f.data.subarray(0, 5));
    for (const offset of [0, f.data.length]) {
      await expect(f.read({ assetId: f.asset.id, offset, length: 32768 })).rejects.toThrow(
        "无法读取受管素材，请确认素材仍可用后重试",
      );
    }
  }
});

test("the Host never registers Panel processing or model installers", async () => {
  const f = await fixture();
  for (const method of [
    "media.tts.setup",
    "media.tts",
    "media.tts.voices",
    "media.audio.extract",
    "media.render",
  ])
    await expect(f.service.dispatch(f.scope, method, {})).rejects.toThrow(
      "Unsupported media method",
    );
  expect(await f.service.jobs.list(f.scope)).toHaveLength(0);
});
