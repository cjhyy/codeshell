import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mobileAssetPath, mobileEntryRedirect, resolveSafe, serveMobile } from "./mobile-static";

test("mobileEntryRedirect canonicalizes the bare entry to a trailing slash", () => {
  // The pairing URL (/mobile?pairing=...) has no trailing slash → must redirect
  // to /mobile/ so the served HTML loads its /mobile/-based assets correctly.
  expect(mobileEntryRedirect("/mobile")).toBe("/mobile/");
  expect(mobileEntryRedirect("/mobile?pairing=tok")).toBe("/mobile/?pairing=tok");
  expect(mobileEntryRedirect("/mobile#frag")).toBe("/mobile/#frag");
});

test("mobileEntryRedirect leaves /mobile/ and sub-paths untouched", () => {
  // With vite base "/mobile/", all assets (prod + vite dev HMR/module URLs) are
  // /mobile-prefixed, so only the bare entry needs the trailing-slash redirect.
  expect(mobileEntryRedirect("/mobile/")).toBeNull();
  expect(mobileEntryRedirect("/mobile/?pairing=tok")).toBeNull();
  expect(mobileEntryRedirect("/mobile/assets/app.js")).toBeNull();
  // A sibling route that merely shares the prefix is not the mobile entry.
  expect(mobileEntryRedirect("/mobilexyz")).toBeNull();
});

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mobile-static-"));
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("mobileAssetPath strips /mobile prefix + query", () => {
  expect(mobileAssetPath("/mobile")).toBe("");
  expect(mobileAssetPath("/mobile/")).toBe("");
  expect(mobileAssetPath("/mobile/assets/app.js")).toBe("assets/app.js");
  expect(mobileAssetPath("/mobile?pairing=tok")).toBe("");
  expect(mobileAssetPath("/mobile/assets/app.js?v=1")).toBe("assets/app.js");
});

test("resolveSafe maps empty path → index.html", () => {
  expect(resolveSafe(root, "")).toBe(join(root, "index.html"));
});

test("resolveSafe serves a real nested asset", () => {
  expect(resolveSafe(root, "assets/app.js")).toBe(join(root, "assets", "app.js"));
});

test("resolveSafe returns null for missing files", () => {
  expect(resolveSafe(root, "nope.js")).toBeNull();
});

test("resolveSafe rejects path traversal", () => {
  expect(resolveSafe(root, "../secret")).toBeNull();
  expect(resolveSafe(root, "../../etc/passwd")).toBeNull();
  expect(resolveSafe(root, "assets/../../escape")).toBeNull();
  expect(resolveSafe(root, "/etc/passwd")).toBeNull();
});

// Lexical `..` was already blocked; a symlink INSIDE the root pointing OUT of it
// was not. `statSync` follows symlinks and the containment check was a string
// compare on the pre-resolution path, so the link passed and its target was
// served. A packaging step or `bun install` leaving a `node_modules` link in the
// served directory is the realistic source.
test("resolveSafe rejects a symlinked file escaping the root", () => {
  if (process.platform === "win32") return; // symlink creation needs elevation
  const outside = mkdtempSync(join(tmpdir(), "mobile-static-outside-"));
  try {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "TOP SECRET");
    const link = join(root, "leak.txt");
    symlinkSync(secret, link);
    try {
      expect(resolveSafe(root, "leak.txt")).toBeNull();
    } finally {
      rmSync(link, { force: true });
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveSafe rejects a file reached through a symlinked directory", () => {
  if (process.platform === "win32") return;
  const outside = mkdtempSync(join(tmpdir(), "mobile-static-outsidedir-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
    const link = join(root, "linked");
    symlinkSync(outside, link, "dir");
    try {
      expect(resolveSafe(root, "linked/secret.txt")).toBeNull();
    } finally {
      rmSync(link, { force: true });
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// The fix must not break links that stay inside the root — a legitimate
// deployment may symlink an asset to another file in the same tree. The
// returned path stays the requested one (callers stream it directly, and the
// existing tests above pin that contract); only the containment CHECK is
// realpath-based.
test("resolveSafe still serves a symlink whose target is inside the root", () => {
  if (process.platform === "win32") return;
  const link = join(root, "alias.js");
  symlinkSync(join(root, "assets", "app.js"), link);
  try {
    expect(resolveSafe(root, "alias.js")).toBe(join(root, "alias.js"));
  } finally {
    rmSync(link, { force: true });
  }
});

// A link pointing at nothing must 404 through the normal contract, not throw a
// realpath ENOENT that would surface as a 500.
test("resolveSafe returns null for a dangling symlink instead of throwing", () => {
  if (process.platform === "win32") return;
  const link = join(root, "dangling.js");
  symlinkSync(join(root, "does-not-exist.js"), link);
  try {
    expect(resolveSafe(root, "dangling.js")).toBeNull();
  } finally {
    rmSync(link, { force: true });
  }
});

// Dev proxy: vite is configured with base "/mobile/", so the proxy MUST forward
// the /mobile prefix intact. Stripping it (the old bug) made vite 404 its HMR
// client (/@vite/client) → phone never live-updates. This test spins up a fake
// upstream that echoes the path it received and asserts the prefix survives.
test("serveMobile dev proxy preserves the /mobile prefix (HMR fix)", async () => {
  let upstream: Server | undefined;
  try {
    const receivedPaths: string[] = [];
    upstream = createServer((ureq, ures) => {
      receivedPaths.push(ureq.url ?? "");
      ures.writeHead(200, { "content-type": "text/plain" });
      ures.end("ok");
    });
    await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
    const port = (upstream.address() as { port: number }).port;
    const devUrl = `http://127.0.0.1:${port}`;

    // Drive serveMobile through a real HTTP round-trip so req/res are genuine
    // node objects (serveMobile reads req.url and pipes the upstream response).
    const front = createServer((freq, fres) => {
      serveMobile(freq, fres, { rootDir: root, devUrl });
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const frontPort = (front.address() as { port: number }).port;

    const fetchPath = (p: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const r = httpRequest({ hostname: "127.0.0.1", port: frontPort, path: p }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        r.on("error", reject);
        r.end();
      });

    await fetchPath("/mobile/@vite/client");
    await fetchPath("/mobile/src/main.tsx");
    await new Promise<void>((r) => front.close(() => r()));

    // The whole point: vite (base "/mobile/") must receive the /mobile-prefixed
    // path, NOT a stripped /@vite/client.
    expect(receivedPaths).toContain("/mobile/@vite/client");
    expect(receivedPaths).toContain("/mobile/src/main.tsx");
  } finally {
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  }
});
