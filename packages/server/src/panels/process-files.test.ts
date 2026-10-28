import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type ServerResponse } from "node:http";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePanelProcessDirectory } from "./process-files.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(workspace?: string, linkPrefix?: string) {
  const temporary = await mkdtemp(join(tmpdir(), "panel-process-files-"));
  await mkdir(join(temporary, "downloads"));
  const root = await realpath(join(temporary, "downloads"));
  cleanups.push(() => rm(temporary, { recursive: true, force: true }));
  const bytes = Buffer.from(Array.from({ length: 20 * 1024 }, (_, i) => i % 251));
  await writeFile(join(root, "演示 视频.mp4"), bytes);
  const baseUrl = "/api/v1/panels/runtime/instance-123/directory/handle-456";
  const state = {
    allowed: true,
    checks: 0,
    hook: undefined as undefined | ((response: ServerResponse) => Promise<void>),
  };
  const server = createServer((request, response) => {
    void handlePanelProcessDirectory(request, response, {
      root,
      baseUrl,
      linkPrefix,
      workspace,
      isAuthorized: async () => {
        state.checks++;
        await state.hook?.(response);
        return state.allowed;
      },
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const request = (query = "", method = "GET", headers?: Record<string, string>) =>
    fetch(origin + baseUrl + query, { method, headers });
  return { root, temporary, bytes, baseUrl, state, request, origin };
}

describe("Panel process directory downloads", () => {
  test("project prefix is applied to download links without changing internal route validation", async () => {
    const prefix = "/p/7bc54c17-1af8-4105-87c1-f4e5c6638998";
    const f = await fixture("/workspace", prefix);
    const html = await (await f.request()).text();
    expect(html).toContain(`href="${prefix}${f.baseUrl}?file=`);
    expect((await f.request(`?file=${encodeURIComponent("演示 视频.mp4")}`)).status).toBe(200);
    const invalid = await fixture(undefined, "//evil.example");
    expect((await invalid.request()).status).toBe(400);
  });
  test("preserves only the trusted workspace in cookie-based browsing and download links", async () => {
    const workspace = "/srv/项目 A&team=<primary>";
    const f = await fixture(workspace);
    const query = `?workspace=${encodeURIComponent(workspace)}`;
    const listing = await f.request(query);
    expect(listing.status).toBe(200);
    const html = await listing.text();
    const href = /href="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
    expect(href).toBeDefined();
    expect(new URL(href!, f.origin).searchParams.get("workspace")).toBe(workspace);
    expect(html).not.toContain("<primary>");
    const download = await fetch(f.origin + href);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(f.bytes);
    const withoutQuery = await (await f.request()).text();
    expect(withoutQuery).toContain("workspace=" + encodeURIComponent(workspace));
    expect((await f.request("?workspace=%2Fsrv%2Fother")).status).toBe(400);
    expect((await f.request(query + "&workspace=" + encodeURIComponent(workspace))).status).toBe(
      400,
    );
    const unscoped = await fixture();
    expect((await unscoped.request(query)).status).toBe(400);
  });
  test("lists escaped export files with no scripts and serves exact bytes through attachment GET and HEAD", async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'preview<svg>&".html'), "<script>never inline</script>");
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("style-src 'unsafe-inline'");
    const html = await response.text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain(f.root);
    expect(html).toContain("preview&lt;svg&gt;&amp;&quot;.html");
    expect(html).toContain(encodeURIComponent("演示 视频.mp4"));
    const query = `?file=${encodeURIComponent("演示 视频.mp4")}`;
    const download = await f.request(query);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-length")).toBe(String(f.bytes.length));
    expect(download.headers.get("accept-ranges")).toBe("bytes");
    expect(download.headers.get("content-range")).toBeNull();
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(download.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''" + encodeURIComponent("演示 视频.mp4"),
    );
    expect(Buffer.from(await download.arrayBuffer())).toEqual(f.bytes);
    const head = await f.request(query, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(f.bytes.length));
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(await head.text()).toBe("");
    const listingHead = await f.request("", "HEAD");
    expect(listingHead.status).toBe(200);
    expect(Number(listingHead.headers.get("content-length"))).toBe(Buffer.byteLength(html));
    expect(await listingHead.text()).toBe("");
    const activeHtml = await f.request(`?file=${encodeURIComponent('preview<svg>&".html')}`);
    expect(activeHtml.headers.get("content-type")).toBe("application/octet-stream");
    expect(activeHtml.headers.get("content-disposition")).toContain("attachment");
  });

  test("serves exact closed, open-ended and suffix ranges through GET and HEAD", async () => {
    const f = await fixture();
    const query = `?file=${encodeURIComponent("演示 视频.mp4")}`;
    for (const [range, start, end] of [
      ["bytes=3-12", 3, 12],
      ["bytes=5-", 5, f.bytes.length - 1],
      ["bytes=-17", f.bytes.length - 17, f.bytes.length - 1],
      ["bytes=20475-99999", 20475, f.bytes.length - 1],
      ["bytes=-99999", 0, f.bytes.length - 1],
      ["bytes=0-0", 0, 0],
    ] as const) {
      for (const method of ["GET", "HEAD"]) {
        const response = await f.request(query, method, { Range: range });
        expect(response.status).toBe(206);
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(response.headers.get("content-range")).toBe(
          `bytes ${start}-${end}/${f.bytes.length}`,
        );
        expect(response.headers.get("content-length")).toBe(String(end - start + 1));
        expect(response.headers.get("content-disposition")).toContain("attachment;");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          method === "HEAD" ? Buffer.alloc(0) : f.bytes.subarray(start, end + 1),
        );
      }
    }
  });

  test("rejects unsatisfiable, malformed and multiple ranges without returning file bytes", async () => {
    const f = await fixture();
    const query = `?file=${encodeURIComponent("演示 视频.mp4")}`;
    for (const range of [
      `bytes=${f.bytes.length}-`,
      "bytes=12-3",
      "bytes=-0",
      "bytes=-",
      "bytes=",
      "bytes=1.5-4",
      "bytes=0-1,3-4",
      "bytes=9007199254740992-",
      "bytes=-9007199254740992",
      "items=0-1",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await f.request(query, method, { Range: range });
        expect(response.status).toBe(416);
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(response.headers.get("content-range")).toBe(`bytes */${f.bytes.length}`);
        expect(response.headers.get("content-length")).toBe("0");
        expect(await response.text()).toBe("");
      }
    }
  });

  test("empty files are downloadable but have no satisfiable byte range", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "empty.txt"), "");
    for (const method of ["GET", "HEAD"]) {
      const full = await f.request("?file=empty.txt", method);
      expect(full.status).toBe(200);
      expect(full.headers.get("content-length")).toBe("0");
      expect(await full.text()).toBe("");
      for (const range of ["bytes=0-", "bytes=-1"]) {
        const response = await f.request("?file=empty.txt", method, { Range: range });
        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */0");
        expect(await response.text()).toBe("");
      }
    }
  });

  test("returns the complete mutable output when an If-Range validator cannot be confirmed", async () => {
    const f = await fixture();
    const query = `?file=${encodeURIComponent("演示 视频.mp4")}`;
    for (const condition of ['"previous-output"', "Wed, 21 Oct 2015 07:28:00 GMT"]) {
      const response = await f.request(query, "GET", {
        Range: "bytes=3-12",
        "If-Range": condition,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("content-length")).toBe(String(f.bytes.length));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
    }
  });

  test("does not list or serve hidden names, credentials, cookies, directories, symlinks or hardlinks", async () => {
    const f = await fixture();
    for (const name of [
      ".env",
      ".hidden.mp4",
      "credentials.json",
      "cookies.txt",
      "account-token.json",
      "id_rsa",
      "private.key",
    ])
      await writeFile(join(f.root, name), "credential-private-marker");
    await mkdir(join(f.root, "nested.mp4"));
    await writeFile(join(f.root, "nested.mp4", "inside.mp4"), "nested-private-marker");
    const privateFile = join(f.temporary, "private.mp4");
    await writeFile(privateFile, "linked-private-marker");
    await symlink(privateFile, join(f.root, "linked.mp4"));
    await link(privateFile, join(f.root, "hardlink.mp4"));
    const html = await (await f.request()).text();
    for (const name of [
      ".env",
      "credentials.json",
      "cookies.txt",
      "account-token.json",
      "nested.mp4",
      "linked.mp4",
      "hardlink.mp4",
    ])
      expect(html).not.toContain(name);
    for (const name of [
      "credentials.json",
      "cookies.txt",
      "account-token.json",
      "nested.mp4",
      "linked.mp4",
      "hardlink.mp4",
      "private.key",
    ]) {
      for (const headers of [undefined, { Range: "bytes=0-1" }])
        expect((await f.request(`?file=${encodeURIComponent(name)}`, "GET", headers)).status).toBe(
          404,
        );
    }
    expect((await f.request("?file=.hidden.mp4")).status).toBe(400);
    expect((await f.request("?file=nested.mp4%2Finside.mp4")).status).toBe(400);
  });

  test("rejects malformed names and query fields without exposing filesystem paths", async () => {
    const f = await fixture();
    for (const query of [
      "?file=",
      "?file=..%2Fprivate.mp4",
      "?file=%2Fetc%2Fpasswd",
      "?file=a%5Cb.mp4",
      "?file=a%0D%0AX-Injected%3Ayes.mp4",
      "?file=a.mp4&file=b.mp4",
      "?path=secret",
      "?file=CON.mp4",
    ])
      expect((await f.request(query)).status).toBe(400);
    const missing = await f.request("?file=absent.mp4");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(f.root);
    expect((await f.request("", "POST")).status).toBe(405);
    expect((await fetch(f.origin + f.baseUrl + "/nested")).status).toBe(400);
  });

  test("caps the listing at 200 entries and refuses files larger than 2 GiB", async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 210 }, (_, i) => writeFile(join(f.root, `clip-${i}.mp4`), "small")),
    );
    const large = await open(join(f.root, "oversized.mp4"), "w");
    await large.truncate(2 * 1024 * 1024 * 1024 + 1);
    await large.close();
    const html = await (await f.request()).text();
    expect((html.match(/<li>/g) ?? []).length).toBe(200);
    expect(html).toContain("最多显示 200 项");
    expect(html).not.toContain("oversized.mp4");
    expect((await f.request("?file=oversized.mp4")).status).toBe(413);
    for (const method of ["GET", "HEAD"])
      expect((await f.request("?file=oversized.mp4", method, { Range: "bytes=0-1" })).status).toBe(
        413,
      );
    const boundary = await open(join(f.root, "boundary.mp4"), "w");
    const limit = 2 * 1024 * 1024 * 1024;
    await boundary.truncate(limit);
    await boundary.close();
    const head = await f.request("?file=boundary.mp4", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(limit));
    const tail = await f.request("?file=boundary.mp4", "GET", { Range: "bytes=-1" });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(`bytes ${limit - 1}-${limit - 1}/${limit}`);
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(Buffer.from([0]));
  });

  test("rechecks authorization after async directory and file work", async () => {
    for (const query of ["", `?file=${encodeURIComponent("演示 视频.mp4")}`]) {
      const f = await fixture();
      f.state.hook = async () => {
        if (f.state.checks === 3) f.state.allowed = false;
      };
      const response = await f.request(query);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("演示 视频.mp4");
    }
  });

  test("changing the directory or swapping a file for a symlink during validation fails closed", async () => {
    for (const kind of ["directory", "file"] as const) {
      const f = await fixture();
      let changed = false;
      f.state.hook = async () => {
        if (changed || f.state.checks !== (kind === "directory" ? 5 : 6)) return;
        changed = true;
        if (kind === "directory") {
          await rename(f.root, f.root + "-old");
          await mkdir(f.root);
          await writeFile(join(f.root, "演示 视频.mp4"), "replacement-private-marker");
        } else {
          const path = join(f.root, "演示 视频.mp4");
          await rename(path, path + ".old");
          await symlink(path + ".old", path);
        }
      };
      const response = await f.request(`?file=${encodeURIComponent("演示 视频.mp4")}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("replacement-private-marker");
      expect(changed).toBe(true);
    }
  });

  test("revocation after headers destroys an active download instead of streaming file bytes", async () => {
    for (const headers of [undefined, { Range: "bytes=3-12" }]) {
      const f = await fixture();
      let observedHeaders = false;
      let interrupted: ServerResponse | undefined;
      f.state.hook = async (response) => {
        if (response.headersSent) {
          observedHeaders = true;
          interrupted = response;
          f.state.allowed = false;
        }
      };
      let received = Buffer.alloc(0);
      try {
        const response = await f.request(
          `?file=${encodeURIComponent("演示 视频.mp4")}`,
          "GET",
          headers,
        );
        received = Buffer.from(await response.arrayBuffer());
      } catch {
        /* Revocation intentionally closes the in-flight stream. */
      }
      expect(observedHeaders).toBe(true);
      expect(received.length).toBe(0);
      expect(interrupted?.destroyed).toBe(true);
      expect(await readFile(join(f.root, "演示 视频.mp4"))).toEqual(f.bytes);
    }
  });

  test("revocation stops a partial download after its first chunk and denies resumed requests", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "stream.mp4"), Buffer.alloc(512 * 1024, 0x61));
    let acknowledgeFirstChunk!: () => void;
    const firstChunkReceived = new Promise<void>((resolve) => {
      acknowledgeFirstChunk = resolve;
    });
    let streamingChecks = 0;
    f.state.hook = async (response) => {
      if (response.headersSent && ++streamingChecks > 1) {
        await firstChunkReceived;
        f.state.allowed = false;
      }
    };
    let receivedBytes = 0;
    let interrupted = false;
    try {
      const response = await f.request("?file=stream.mp4", "GET", { Range: "bytes=65536-458751" });
      expect(response.status).toBe(206);
      const reader = response.body!.getReader();
      const first = await reader.read();
      receivedBytes += first.value?.byteLength ?? 0;
      acknowledgeFirstChunk();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          receivedBytes += next.value.byteLength;
        }
      } catch {
        interrupted = true;
      }
    } finally {
      acknowledgeFirstChunk();
    }
    expect(receivedBytes).toBeGreaterThan(0);
    expect(receivedBytes).toBeLessThan(458751 - 65536 + 1);
    expect(streamingChecks).toBeGreaterThan(1);
    expect(interrupted).toBe(true);
    for (const range of ["bytes=131072-", "bytes=999999-"]) {
      const denied = await f.request("?file=stream.mp4", "GET", { Range: range });
      expect(denied.status).toBe(403);
      expect(denied.headers.get("content-range")).toBeNull();
    }
  });
});
