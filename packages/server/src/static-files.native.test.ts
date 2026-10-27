import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInSubprocess } from "../../../tests/helpers/bundle-in-subprocess.ts";

test("native static delivery bounds reads and releases files on HEAD, errors, and disconnects", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "static-delivery-native-"));
  try {
    bundleInSubprocess(
      [
        fileURLToPath(new URL("static-files.ts", import.meta.url)),
        fileURLToPath(new URL("mobile-remote/mobile-static.ts", import.meta.url)),
      ],
      temporary,
      { naming: "[name].js" },
    );
    await writeFile(join(temporary, "package.json"), '{"type":"module"}');
    await writeFile(
      join(temporary, "fixture.mjs"),
      String.raw`
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, get } from "node:http";
import { join } from "node:path";
import { streamStaticFile } from "./static-files.js";
import { serveMobile } from "./mobile-static.js";

const root = join(process.cwd(), "app");
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "assets/app.js"), "original bytes");
writeFileSync(join(root, "index.html"), "app shell");
writeFileSync(join(root, "large.bin"), Buffer.alloc(32 * 1024 * 1024, 65));
const probe = await open(join(root, "index.html"));
const prototype = Object.getPrototypeOf(probe);
await probe.close();
const originalCreateReadStream = prototype.createReadStream;
const reads = [];
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
try {
  const head = await fetch(origin + "/large.bin", { method: "HEAD" });
  await completed;
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(32 * 1024 * 1024));
  assert.equal(await head.text(), "");
  assert.equal(reads.length, 0, "HEAD must not create a file reader");

  beforeHeaders = () => appendFileSync(join(root, "assets/app.js"), " appended");
  assert.equal(await (await fetch(origin + "/assets/app.js")).text(), "original bytes");
  await completed;
  assert.equal(reads.at(-1).fd, -1, "completed body must close its file");
  beforeHeaders = undefined;

  const missing = await fetch(origin + "/missing.js");
  await completed;
  assert.equal(missing.status, 404);

  if (process.platform !== "win32") {
    const outside = join(process.cwd(), "outside.txt");
    writeFileSync(outside, "private bytes");
    symlinkSync(outside, join(root, "escape.txt"));
    assert.equal((await fetch(origin + "/escape.txt")).status, 404);
    symlinkSync(join(root, "assets/app.js"), join(root, "alias.js"));
    assert.equal(await (await fetch(origin + "/alias.js")).text(), "original bytes appended");
    await completed;
  }

  injectReadError = true;
  await assert.rejects(async () => {
    const response = await fetch(origin + "/large.bin");
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
  const mobile = await fetch(origin + "/mobile/assets/app.js");
  assert.equal(mobile.status, 200);
  assert.equal(mobile.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await mobile.text(), "pinned mobile bytes");
  beforeHeaders = undefined;
  assert.equal((await fetch(origin + "/mobile/missing.js")).status, 404);
  const shell = await fetch(origin + "/mobile/route", { headers: { accept: "text/html" } });
  assert.equal(shell.headers.get("cache-control"), "no-store");
  assert.equal(await shell.text(), "app shell");
  console.log("PASS native static delivery");
} finally {
  beforeHeaders = undefined;
  prototype.createReadStream = originalCreateReadStream;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
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
