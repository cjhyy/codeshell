import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInSubprocess } from "../../../tests/helpers/bundle-in-subprocess.js";

test("native static delivery bounds reads and releases files on HEAD, errors, and disconnects", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "static-delivery-native-"));
  try {
    bundleInSubprocess(
      [
        fileURLToPath(new URL("static-files.ts", import.meta.url)),
        fileURLToPath(new URL("mobile-remote/mobile-static.ts", import.meta.url)),
        fileURLToPath(new URL("../../../tests/helpers/network-fixture.ts", import.meta.url)),
      ],
      temporary,
      { naming: "[name].js" },
    );
    await writeFile(join(temporary, "package.json"), '{"type":"module"}');
    await writeFile(
      join(temporary, "fixture.mjs"),
      String.raw`
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, get } from "node:http";
import { join } from "node:path";
import { installFixtureNetworkGuard } from "./network-fixture.js";
const guard = installFixtureNetworkGuard();
const { streamStaticFile } = await import("./static-files.js");
const { serveMobile } = await import("./mobile-static.js");

const root = join(process.cwd(), "app");
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "assets/app.js"), "original bytes");
writeFileSync(join(root, "index.html"), "app shell");
writeFileSync(join(root, "large.bin"), Buffer.alloc(32 * 1024 * 1024, 65));
const probe = await open(join(root, "index.html"));
const prototype = Object.getPrototypeOf(probe);
await probe.close();
const originalCreateReadStream = prototype.createReadStream;
const originalStat = prototype.stat;
const reads = [];
const opened = [];
let afterFileStat;
prototype.stat = async function (...args) {
  opened.push(this);
  const result = await originalStat.apply(this, args);
  afterFileStat?.();
  return result;
};
let injectReadError = false;
prototype.createReadStream = function (options) {
  reads.push(this);
  const stream = originalCreateReadStream.call(this, options);
  if (injectReadError) queueMicrotask(() => stream.destroy(new Error("fixture read failure")));
  return stream;
};
let beforeHeaders;
let completed = Promise.resolve();
const server = createServer((req, res) => {
  const originalWriteHead = res.writeHead;
  res.writeHead = function (...args) {
    beforeHeaders?.();
    return originalWriteHead.apply(this, args);
  };
  if (req.url.startsWith("/mobile")) {
    serveMobile(req, res, { rootDir: root });
  } else {
    completed = streamStaticFile(req, res, {
      rootDir: root,
      filePath: join(root, req.url.slice(1)),
      cacheControl: "no-cache",
    });
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
guard.allowOrigin(origin);
const fixtureFetch = (url, options) => fetch(url, { ...options, redirect: "error" });
try {
  const head = await fixtureFetch(origin + "/large.bin", { method: "HEAD" });
  await completed;
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(32 * 1024 * 1024));
  assert.equal(await head.text(), "");
  assert.equal(reads.length, 0, "HEAD must not create a file reader");

  const asset = await fixtureFetch(origin + "/assets/app.js");
  const etag = asset.headers.get("etag");
  assert.match(etag, /^W\/"[A-Za-z0-9_-]+"$/);
  assert.equal(await asset.text(), "original bytes");
  await completed;
  const beforeConditionalReads = reads.length;
  for (const method of ["GET", "HEAD"]) {
    for (const condition of [etag, etag.slice(2), '"other,tag", ' + etag, ', ' + etag + ',,', '*']) {
      const response = await fixtureFetch(origin + "/assets/app.js", { method, headers: { "if-none-match": condition } });
      await completed;
      assert.equal(response.status, 304, method + " " + condition);
      assert.equal(response.headers.get("etag"), etag);
      assert.equal(response.headers.get("cache-control"), "no-cache");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("content-length"), null);
      assert.equal(await response.text(), "");
      assert.equal(reads.length, beforeConditionalReads, "304 must not create a file reader");
      assert.equal(opened.at(-1).fd, -1, "304 must close the validated file");
    }
  }
  for (const condition of ['"different"', '"other,' + etag.slice(3, -1) + '"', 'w/' + etag.slice(2), etag + ' junk', etag + ',broken', etag + ',"unfinished', '*,' + etag, '"has space",' + etag]) {
    const response = await fixtureFetch(origin + "/assets/app.js", { headers: { "if-none-match": condition } });
    assert.equal(response.status, 200, "unmatched or invalid condition: " + condition);
    assert.equal(await response.text(), "original bytes");
    await completed;
  }
  const post = await fixtureFetch(origin + "/assets/app.js", { method: "POST", headers: { "if-none-match": etag } });
  assert.equal(post.status, 200, "the shared file helper only revalidates GET/HEAD");
  assert.equal(await post.text(), "original bytes");
  await completed;

  const metadata = statSync(join(root, "assets/app.js"));
  writeFileSync(join(root, "assets/app.js"), "modified bytes");
  utimesSync(join(root, "assets/app.js"), metadata.atime, metadata.mtime);
  const modified = await fixtureFetch(origin + "/assets/app.js", { headers: { "if-none-match": etag } });
  assert.equal(modified.status, 200, "same size and restored mtime must still invalidate");
  assert.notEqual(modified.headers.get("etag"), etag);
  assert.equal(await modified.text(), "modified bytes");
  await completed;
  const modifiedTag = modified.headers.get("etag");
  writeFileSync(join(root, "replacement.js"), "replaced bytes");
  utimesSync(join(root, "replacement.js"), metadata.atime, metadata.mtime);
  renameSync(join(root, "replacement.js"), join(root, "assets/app.js"));
  const replaced = await fixtureFetch(origin + "/assets/app.js", { headers: { "if-none-match": modifiedTag } });
  assert.equal(replaced.status, 200, "atomic replacement must invalidate");
  assert.notEqual(replaced.headers.get("etag"), modifiedTag);
  assert.equal(await replaced.text(), "replaced bytes");
  await completed;
  afterFileStat = () => writeFileSync(join(root, "assets/app.js"), "racing rewrite");
  const racing = await fixtureFetch(origin + "/assets/app.js", { headers: { "if-none-match": replaced.headers.get("etag") } });
  assert.equal(racing.status, 404, "changed metadata cannot authorize a stale 304");
  assert.equal(await racing.text(), "not found");
  await completed;
  assert.equal(opened.at(-1).fd, -1, "a changed conditional file must close its handle");
  afterFileStat = undefined;
  writeFileSync(join(root, "assets/app.js"), "original bytes");

  beforeHeaders = () => appendFileSync(join(root, "assets/app.js"), " appended");
  assert.equal(await (await fixtureFetch(origin + "/assets/app.js")).text(), "original bytes");
  await completed;
  assert.equal(reads.at(-1).fd, -1, "completed body must close its file");
  beforeHeaders = undefined;
  afterFileStat = undefined;

  const missing = await fixtureFetch(origin + "/missing.js");
  await completed;
  assert.equal(missing.status, 404);

  if (process.platform !== "win32") {
    const outside = join(process.cwd(), "outside.txt");
    writeFileSync(outside, "private bytes");
    symlinkSync(outside, join(root, "escape.txt"));
    assert.equal((await fixtureFetch(origin + "/escape.txt")).status, 404);
    writeFileSync(join(root, "conditional.txt"), "public bytes");
    const original = await fixtureFetch(origin + "/conditional.txt");
    const oldTag = original.headers.get("etag");
    await original.text();
    await completed;
    rmSync(join(root, "conditional.txt"));
    symlinkSync(outside, join(root, "conditional.txt"));
    for (const condition of [oldTag, "*"]) {
      const escaped = await fixtureFetch(origin + "/conditional.txt", { headers: { "if-none-match": condition } });
      assert.equal(escaped.status, 404, "conditional headers cannot bypass root confinement");
      assert.equal(await escaped.text(), "not found");
    }
    symlinkSync(join(root, "assets/app.js"), join(root, "alias.js"));
    assert.equal(await (await fixtureFetch(origin + "/alias.js")).text(), "original bytes appended");
    await completed;
  }

  injectReadError = true;
  await assert.rejects(async () => {
    const response = await fixtureFetch(origin + "/large.bin");
    await response.arrayBuffer();
  });
  await completed;
  assert.equal(reads.at(-1).fd, -1, "failed stream must close its file");
  injectReadError = false;

  await new Promise((resolve, reject) => {
    const request = get(origin + "/large.bin", response => {
      response.once("data", () => { response.destroy(); resolve(); });
      response.on("error", () => {});
    });
    request.on("error", reject);
  });
  await completed;
  assert.equal(reads.at(-1).fd, -1, "disconnected response must close its file");

  // Mobile previously opened the file only after writeHead, and an unlink at
  // this point emitted an unhandled stream error. The fixed FD remains usable.
  writeFileSync(join(root, "assets/app.js"), "pinned mobile bytes");
  beforeHeaders = () => rmSync(join(root, "assets/app.js"));
  const mobile = await fixtureFetch(origin + "/mobile/assets/app.js");
  assert.equal(mobile.status, 200);
  assert.equal(mobile.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await mobile.text(), "pinned mobile bytes");
  beforeHeaders = undefined;
  assert.equal((await fixtureFetch(origin + "/mobile/missing.js")).status, 404);
  const shell = await fixtureFetch(origin + "/mobile/route", { headers: { accept: "text/html" } });
  assert.equal(shell.headers.get("cache-control"), "no-store");
  assert.equal(await shell.text(), "app shell");
  const cachedShell = await fixtureFetch(origin + "/mobile/route", { headers: { accept: "text/html", "if-none-match": shell.headers.get("etag") } });
  assert.equal(cachedShell.status, 304);
  assert.equal(cachedShell.headers.get("cache-control"), "no-store");
  assert.equal(cachedShell.headers.get("content-length"), null);
  assert.equal(await cachedShell.text(), "");
  writeFileSync(join(root, "assets/app.js"), "cacheable mobile bytes");
  const mobileAsset = await fixtureFetch(origin + "/mobile/assets/app.js");
  await mobileAsset.text();
  const cachedMobile = await fixtureFetch(origin + "/mobile/assets/app.js", { headers: { "if-none-match": mobileAsset.headers.get("etag") } });
  assert.equal(cachedMobile.status, 304);
  assert.equal(cachedMobile.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await cachedMobile.text(), "");
  console.log("PASS native static delivery");
} finally {
  beforeHeaders = undefined;
  prototype.createReadStream = originalCreateReadStream;
  prototype.stat = originalStat;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  guard.restore();
}
`,
    );
    const child = Bun.spawn(["node", join(temporary, "fixture.mjs")], {
      cwd: temporary,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain("PASS native static delivery");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);
