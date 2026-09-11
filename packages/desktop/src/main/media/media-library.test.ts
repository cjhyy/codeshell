import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { truncateSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaLibrary, type MediaReadResult } from "./media-library.js";
import { mediaScopeKey } from "./media-storage.js";

const scope = { appId: "video-studio", projectPath: "/workspace/project-a" };
let directory: string;
let library: MediaLibrary;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codeshell-media-library-"));
  library = new MediaLibrary({ rootDirectory: join(directory, "data"), now: () => 1234 });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function source(name = "source.mp4", bytes = Buffer.from("0123456789")): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}
async function body(response: MediaReadResult): Promise<string> {
  if (!response.body) return "";
  const chunks = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

describe("persistent authorized media library", () => {
  test("streams, hashes and deduplicates copies independent of the source and service lifetime", async () => {
    const file = await source();
    const progress: number[] = [];
    const asset = await library.importFile(scope, file, {
      onProgress: (copied) => progress.push(copied),
    });
    expect(asset).toEqual({
      id: `asset-${createHash("sha256").update("0123456789").digest("hex")}`,
      name: "source.mp4",
      bytes: 10,
      sha256: createHash("sha256").update("0123456789").digest("hex"),
      mimeType: "video/mp4",
      createdAt: 1234,
    });
    const duplicate = await library.importFile(scope, file, { name: "renamed.mp4" });
    expect(duplicate).toEqual(asset);
    await rm(file);
    const restored = new MediaLibrary({ rootDirectory: join(directory, "data") });
    expect(await restored.list(scope)).toEqual([asset]);
    expect(await readFile(await restored.resolvePath(scope, asset.id), "utf8")).toBe("0123456789");
    expect(progress.at(-1)).toBe(10);
    expect(Object.keys(asset)).not.toContain("path");
  });

  test("serves full, bounded, suffix and open-ended ranges plus HEAD without loading all bytes", async () => {
    const asset = await library.importFile(scope, await source());
    expect(await body(await library.openRead(scope, asset.id))).toBe("0123456789");
    const bounded = await library.openRead(scope, asset.id, { range: "bytes=2-5" });
    expect(bounded.status).toBe(206);
    expect(bounded.headers["Content-Range"]).toBe("bytes 2-5/10");
    expect(await body(bounded)).toBe("2345");
    expect(await body(await library.openRead(scope, asset.id, { range: "bytes=-3" }))).toBe("789");
    expect(await body(await library.openRead(scope, asset.id, { range: "bytes=8-" }))).toBe("89");
    expect(await body(await library.openRead(scope, asset.id, { range: "bytes=8-100" }))).toBe(
      "89",
    );
    const head = await library.openRead(scope, asset.id, { method: "HEAD", range: "bytes=1-2" });
    expect(head.status).toBe(206);
    expect(head.body).toBeNull();
    expect(head.headers["Content-Length"]).toBe("2");
    for (const range of [
      "bytes=10-",
      "bytes=4-2",
      "bytes=-0",
      "bytes=1-2,4-5",
      "bytes=",
      "items=0-1",
    ]) {
      const result = await library.openRead(scope, asset.id, { range });
      expect(result.status).toBe(416);
      expect(result.body).toBeNull();
      expect(result.headers["Content-Range"]).toBe("bytes */10");
    }
    expect((await library.openRead(scope, asset.id, { method: "POST" })).status).toBe(405);
  });

  test("fails closed across app/project bindings and rejects traversal or active MIME types", async () => {
    const asset = await library.importFile(scope, await source("payload.html"), {
      mimeType: "text/html",
    });
    expect(asset.mimeType).toBe("application/octet-stream");
    const result = await library.openRead(scope, asset.id, { method: "HEAD" });
    expect(result.headers["Content-Security-Policy"]).toContain("sandbox");
    await expect(library.get({ ...scope, appId: "another-app" }, asset.id)).rejects.toThrow();
    await expect(
      library.openRead({ ...scope, projectPath: "/workspace/project-b" }, asset.id),
    ).rejects.toThrow();
    await expect(library.get(scope, "../../secret")).rejects.toThrow("Invalid media asset ID");
    await expect(library.list({ ...scope, projectPath: "relative" })).rejects.toThrow("absolute");
  });

  test("concurrent duplicate imports publish one complete record", async () => {
    const file = await source("source.wav", Buffer.alloc(1024 * 1024, 9));
    const [left, right] = await Promise.all([
      library.importFile(scope, file),
      library.importFile(scope, file),
    ]);
    expect(left).toEqual(right);
    expect((await library.list(scope)).length).toBe(1);
    expect(await readdir(join(directory, "data/scopes", mediaScopeKey(scope), "imports"))).toEqual(
      [],
    );
  });

  test("cancelled or mutated imports do not publish partial assets", async () => {
    const file = await source("large.mp4", Buffer.alloc(2 * 1024 * 1024, 3));
    const controller = new AbortController();
    await expect(
      library.importFile(scope, file, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow();
    expect(await library.list(scope)).toEqual([]);
    let changed = false;
    await expect(
      library.importFile(scope, file, {
        onProgress: () => {
          if (!changed) {
            changed = true;
            truncateSync(file, 1);
          }
        },
      }),
    ).rejects.toThrow("Source changed");
    expect(await library.list(scope)).toEqual([]);
    expect(await readdir(join(directory, "data/scopes", mediaScopeKey(scope), "imports"))).toEqual(
      [],
    );
  });

  test("rejects selected symlinks, corrupted content and replaced managed directories", async () => {
    const file = await source();
    const link = join(directory, "link.mp4");
    await symlink(file, link);
    await expect(library.importFile(scope, link)).rejects.toThrow();
    const asset = await library.importFile(scope, file);
    const content = await library.resolvePath(scope, asset.id);
    await writeFile(content, "changed-size");
    await expect(library.openRead(scope, asset.id)).rejects.toThrow("changed");
    await rm(content);
    await symlink(file, content);
    await expect(library.openRead(scope, asset.id)).rejects.toThrow();
    await rm(join(directory, "data/scopes", mediaScopeKey(scope), "assets"), { recursive: true });
    await symlink(directory, join(directory, "data/scopes", mediaScopeKey(scope), "assets"));
    await expect(library.list(scope)).rejects.toThrow("symlink");
  });
});
