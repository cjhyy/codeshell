import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaPreviewService, type MediaPreviewAuthority } from "./media-preview-service.js";
import { classifyMediaPath } from "../shared/media-preview.js";

describe("chat media preview authority and streaming", () => {
  let directory: string;
  let root: string;
  let outside: string;
  let authority: MediaPreviewAuthority;
  let alive: boolean;
  let authorized: boolean;
  let service: MediaPreviewService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cs-media-preview-"));
    root = join(directory, "workspace");
    outside = join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "片段.mp4"), "0123456789");
    await writeFile(join(root, "voice.MP3"), "voice");
    await writeFile(join(outside, "secret.mp4"), "secret");
    authority = { mainRootId: "root-1", roots: [{ id: "root-1", path: root, role: "primary" }] };
    alive = true;
    authorized = true;
    service = new MediaPreviewService({
      isOwnerAlive: (ownerId) => alive && ownerId === 7,
      resolveAuthority: async (sessionId, ownerId) => {
        if (!authorized || sessionId !== "task-1" || ownerId !== 7) throw new Error("Revoked");
        return authority;
      },
    });
  });

  afterEach(async () => {
    service.releaseOwner(7);
    await rm(directory, { recursive: true, force: true });
  });

  async function preview(path = "片段.mp4") {
    const value = await service.create(7, { sessionId: "task-1", rootId: "root-1", path });
    expect(value).not.toBeNull();
    return value!;
  }

  test("creates opaque URLs for relative and absolute media without exposing disk paths", async () => {
    const video = await preview();
    expect(video).toMatchObject({ name: "片段.mp4", kind: "video", mimeType: "video/mp4" });
    expect(video.url).toMatch(/^csmedia:\/\/preview\/[a-f0-9]{64}$/);
    expect(video.url).not.toContain(root);
    const audio = await preview(join(root, "voice.MP3"));
    expect(audio).toMatchObject({ kind: "audio", mimeType: "audio/mpeg" });
    expect(classifyMediaPath("movie.WEBM")).toBe("video");
    expect(classifyMediaPath("photo.png")).toBeNull();
  });

  test("streams complete bytes with safe MIME and no-cache headers", async () => {
    const video = await preview();
    const result = await service.respond(new Request(video.url));
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("video/mp4");
    expect(result.headers.get("content-length")).toBe("10");
    expect(result.headers.get("accept-ranges")).toBe("bytes");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("content-security-policy")).toContain("sandbox");
    expect(await result.text()).toBe("0123456789");
  });

  test("supports bounded, suffix, open-ended, clamped and HEAD ranges", async () => {
    const { url } = await preview();
    for (const [range, content, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=8-", "89", "bytes 8-9/10"],
      ["bytes=8-100", "89", "bytes 8-9/10"],
    ]) {
      const result = await service.respond(new Request(url, { headers: { range } }));
      expect(result.status).toBe(206);
      expect(result.headers.get("content-range")).toBe(contentRange);
      expect(await result.text()).toBe(content);
    }
    const head = await service.respond(
      new Request(url, { method: "HEAD", headers: { range: "bytes=1-2" } }),
    );
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("2");
    expect(await head.text()).toBe("");
    expect((await service.respond(new Request(url, { method: "POST" }))).status).toBe(405);
  });

  test("rejects malformed, unsafe and unsatisfiable ranges", async () => {
    const { url } = await preview();
    for (const range of [
      "",
      "bytes=10-",
      "bytes=3-2",
      "bytes=-0",
      "bytes=-",
      "bytes=0-1,3-4",
      "items=0-1",
      "bytes=9007199254740992-",
    ]) {
      const result = await service.respond(new Request(url, { headers: { range } }));
      expect(result.status).toBe(416);
      expect(result.headers.get("content-range")).toBe("bytes */10");
    }
  });

  test("rejects foreign owners, unknown sessions, stale roots and caller-supplied authority", async () => {
    expect(await service.create(8, { sessionId: "task-1", path: "片段.mp4" })).toBeNull();
    for (const input of [
      { sessionId: "task-2", path: "片段.mp4" },
      { sessionId: "task-1", rootId: "stale-root", path: "片段.mp4" },
      { sessionId: "task-1", path: "片段.mp4", cwd: outside },
      { sessionId: "../task-1", path: "片段.mp4" },
      { sessionId: "task-1", path: "片段.mp4\0" },
    ])
      expect(await service.create(7, input)).toBeNull();
  });

  test("rejects outside files, traversal, directories, unknown formats and empty media", async () => {
    await mkdir(join(root, "folder.mp4"));
    await writeFile(join(root, "empty.mp4"), "");
    await writeFile(join(root, "text.html"), "hello");
    for (const path of [
      join(outside, "secret.mp4"),
      "../outside/secret.mp4",
      "folder.mp4",
      "empty.mp4",
      "text.html",
      "missing.mp4",
    ]) {
      expect(await service.create(7, { sessionId: "task-1", path })).toBeNull();
    }
  });

  test("rejects symlink files and symlink parent escape", async () => {
    await symlink(join(outside, "secret.mp4"), join(root, "link.mp4"));
    await symlink(outside, join(root, "linked"));
    for (const path of ["link.mp4", "linked/secret.mp4"]) {
      expect(await service.create(7, { sessionId: "task-1", path })).toBeNull();
    }
  });

  test("allows mounted secondary root media and revokes it when removed", async () => {
    authority.roots.push({ id: "root-2", path: outside, role: "secondary" });
    const { url } = await preview(join(outside, "secret.mp4"));
    expect(await (await service.respond(new Request(url))).text()).toBe("secret");
    authority.roots.pop();
    expect((await service.respond(new Request(url))).status).toBe(404);
  });

  test("checks task authority and main-root migration again on every request", async () => {
    const first = await preview();
    authorized = false;
    expect((await service.respond(new Request(first.url))).status).toBe(404);
    authorized = true;
    const second = await preview();
    authority.mainRootId = "root-2";
    expect((await service.respond(new Request(second.url))).status).toBe(404);
  });

  test("detects file replacement, in-place changes and parent symlink substitution", async () => {
    const first = await preview();
    await rename(join(root, "片段.mp4"), join(root, "old.mp4"));
    await writeFile(join(root, "片段.mp4"), "abcdefghij");
    expect((await service.respond(new Request(first.url))).status).toBe(404);
    const second = await preview();
    await writeFile(join(root, "片段.mp4"), "changed");
    expect((await service.respond(new Request(second.url))).status).toBe(404);
    await mkdir(join(root, "child"));
    await writeFile(join(root, "child", "secret.mp4"), "local");
    const third = await preview("child/secret.mp4");
    await rename(join(root, "child"), join(root, "old-child"));
    await symlink(outside, join(root, "child"));
    expect((await service.respond(new Request(third.url))).status).toBe(404);
  });

  test("detects replacement of the authorized root at the same path", async () => {
    const { url } = await preview();
    await rename(root, `${root}-old`);
    await mkdir(root);
    await writeFile(join(root, "片段.mp4"), "0123456789");
    expect((await service.respond(new Request(url))).status).toBe(404);
  });

  test("only the issuing owner can release a preview; destroyed owners lose all previews", async () => {
    const { url } = await preview();
    service.release(8, url);
    expect((await service.respond(new Request(url, { method: "HEAD" }))).status).toBe(200);
    service.release(7, url);
    expect((await service.respond(new Request(url))).status).toBe(404);
    const next = await preview();
    alive = false;
    expect((await service.respond(new Request(next.url))).status).toBe(404);
  });

  test("rejects forged token URLs and URL credentials/query/hash", async () => {
    const { url } = await preview();
    for (const candidate of [
      `${url}?x=1`,
      `${url}#x`,
      url.replace("preview", "other"),
      url.replace("preview", "user@preview"),
      "csmedia://preview/invalid",
    ]) {
      expect((await service.respond(new Request(candidate))).status).toBe(404);
    }
  });

  test("session revocation aborts a large active stream without buffering the whole file", async () => {
    await writeFile(join(root, "large.mp4"), Buffer.alloc(8 * 1024 * 1024, 7));
    const { url } = await preview("large.mp4");
    const result = await service.respond(new Request(url));
    const reader = result.body!.getReader();
    const first = await reader.read();
    expect(first.value!.byteLength).toBeLessThanOrEqual(64 * 1024);
    service.releaseSession("task-1");
    let received = first.value!.byteLength;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
      }
    } catch {
      /* Revoking an in-flight response intentionally closes its stream. */
    }
    expect(received).toBeLessThan(512 * 1024);
    expect((await service.respond(new Request(url))).status).toBe(404);
  });

  test("cancelling a playback read preserves its token for the next seek range", async () => {
    await writeFile(join(root, "large.mp4"), Buffer.alloc(8 * 1024 * 1024, 7));
    const { url } = await preview("large.mp4");
    const result = await service.respond(new Request(url));
    await result.body!.cancel();
    const seek = await service.respond(new Request(url, { headers: { range: "bytes=1024-2047" } }));
    expect(seek.status).toBe(206);
    expect((await seek.arrayBuffer()).byteLength).toBe(1024);
    const playing = await service.respond(new Request(url));
    const reader = playing.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((done) => setTimeout(done, 20));
    const nextSeek = await service.respond(
      new Request(url, { headers: { range: "bytes=2048-3071" } }),
    );
    expect(nextSeek.status).toBe(206);
    expect((await nextSeek.arrayBuffer()).byteLength).toBe(1024);
  });

  test("aborting a request during authorization preserves subsequent seek access", async () => {
    let pause: Promise<void> | undefined;
    const racing = new MediaPreviewService({
      isOwnerAlive: () => true,
      resolveAuthority: async () => {
        await pause;
        return authority;
      },
    });
    const preview = await racing.create(7, { sessionId: "task-1", path: "片段.mp4" });
    let resume!: () => void;
    pause = new Promise<void>((done) => {
      resume = done;
    });
    const controller = new AbortController();
    const pending = racing.respond(new Request(preview!.url, { signal: controller.signal }));
    controller.abort();
    resume();
    await pending;
    pause = undefined;
    const seek = await racing.respond(
      new Request(preview!.url, { headers: { range: "bytes=2-5" } }),
    );
    expect(seek.status).toBe(206);
    expect(await seek.text()).toBe("2345");
    racing.releaseOwner(7);
  });

  test("aborting an active request closes only that read", async () => {
    await writeFile(join(root, "large.mp4"), Buffer.alloc(8 * 1024 * 1024, 7));
    const { url } = await preview("large.mp4");
    const controller = new AbortController();
    const response = await service.respond(new Request(url, { signal: controller.signal }));
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    const seek = await service.respond(new Request(url, { headers: { range: "bytes=1024-2047" } }));
    expect(seek.status).toBe(206);
    expect((await seek.arrayBuffer()).byteLength).toBe(1024);
  });

  test("large playback does not repeat expensive task authority checks for every chunk", async () => {
    let lookups = 0;
    const counted = new MediaPreviewService({
      isOwnerAlive: () => true,
      resolveAuthority: async () => {
        lookups++;
        return authority;
      },
    });
    await writeFile(join(root, "large.mp4"), Buffer.alloc(8 * 1024 * 1024, 7));
    const value = await counted.create(7, { sessionId: "task-1", path: "large.mp4" });
    lookups = 0;
    const started = Date.now();
    const response = await counted.respond(new Request(value!.url));
    expect((await response.arrayBuffer()).byteLength).toBe(8 * 1024 * 1024);
    expect(lookups).toBeLessThanOrEqual(3 + Math.ceil((Date.now() - started) / 1000));
    counted.releaseOwner(7);
  });

  test("owner cleanup racing token creation cannot leave a live grant", async () => {
    let resolve!: () => void;
    const pause = new Promise<void>((done) => {
      resolve = done;
    });
    const racing = new MediaPreviewService({
      isOwnerAlive: () => true,
      resolveAuthority: async () => {
        await pause;
        return authority;
      },
    });
    const pending = racing.create(7, { sessionId: "task-1", path: "片段.mp4" });
    racing.releaseOwner(7);
    resolve();
    expect(await pending).toBeNull();
  });
});
