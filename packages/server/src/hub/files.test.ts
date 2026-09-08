import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubFiles } from "./files.js";

const fixtures: Array<{ root: string; server: Server; close: () => void }> = [];
afterEach(async () => {
  for (const { root, server, close } of fixtures.splice(0)) {
    close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(onAuthorize?: (cwd: string, call: number) => boolean) {
  const root = mkdtempSync(join(tmpdir(), "cs-hub-files-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  let authorizationCalls = 0;
  const service = createHubFiles({
    cwd,
    isAuthorized: async (req) =>
      req.headers.authorization === "Bearer fixture" &&
      (onAuthorize?.(cwd, ++authorizationCalls) ?? true),
  });
  const server = createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixtures.push({ root, server, close: service.close });
  const port = (server.address() as { port: number }).port;
  const request = (path: string, options = "", authorized = true) =>
    fetch(
      `http://127.0.0.1:${port}/api/v1/files${options.startsWith("content") ? "/content" : ""}?path=${encodeURIComponent(path)}&${options.replace(/^content&?/, "")}`,
      { headers: authorized ? { authorization: "Bearer fixture" } : {} },
    );
  return { root, cwd, request };
}

test("files page lists workspace entries, previews text and downloads exact bytes", async () => {
  const f = await fixture();
  mkdirSync(join(f.cwd, "documents"));
  writeFileSync(join(f.cwd, "documents/报告 #1.txt"), "Hello <script>not executable</script>\n");
  expect((await f.request("", "", false)).status).toBe(401);
  const listing = (await (await f.request("documents")).json()) as any;
  expect(listing.files[0]).toMatchObject({
    name: "报告 #1.txt",
    path: "documents/报告 #1.txt",
    kind: "file",
  });
  const preview = (await (
    await f.request("documents/报告 #1.txt", "content&preview=true")
  ).json()) as any;
  expect(preview.kind).toBe("text");
  expect(preview.content).toContain("<script>not executable</script>");
  const download = await f.request(join(f.cwd, "documents/报告 #1.txt"), "content");
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("attachment;");
  expect(download.headers.get("content-disposition")).toContain("filename*=UTF-8''");
  expect(download.headers.get("cache-control")).toBe("no-store");
  expect(download.headers.get("content-security-policy")).toContain("sandbox");
  expect(await download.text()).toBe(preview.content);
});

test("directory traversal, foreign paths, symlinks and private configuration cannot be read", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "fixture secret");
  symlinkSync(outside, join(f.cwd, "escape"));
  symlinkSync(join(outside, "secret.txt"), join(f.cwd, "linked.txt"));
  mkdirSync(join(f.cwd, ".code-shell"));
  writeFileSync(join(f.cwd, ".code-shell/settings.local.json"), '{"apiKey":"fixture-secret"}');
  writeFileSync(join(f.cwd, ".env"), "KEY=fixture");
  for (const path of [
    "../outside/secret.txt",
    join(outside, "secret.txt"),
    "escape/secret.txt",
    "linked.txt",
    ".code-shell/settings.local.json",
    ".env",
  ]) {
    expect((await f.request(path, "content")).status).toBe(403);
  }
  const listing = (await (await f.request("")).json()) as any;
  expect(listing.files).toHaveLength(0);
});

test("large text previews are bounded, binary files do not become executable inline content", async () => {
  const f = await fixture();
  writeFileSync(join(f.cwd, "large.txt"), "a".repeat(600 * 1024));
  const preview = (await (await f.request("large.txt", "content&preview=true")).json()) as any;
  expect(preview.truncated).toBe(true);
  expect(preview.content.length).toBe(512 * 1024);
  writeFileSync(join(f.cwd, "page.html"), "<script>parent.alert(1)</script>");
  const html = await f.request("page.html", "content&inline=true");
  expect(html.headers.get("content-type")).toBe("application/octet-stream");
  expect(html.headers.get("content-disposition")).toContain("attachment;");
  writeFileSync(join(f.cwd, "image.svg"), '<svg onload="alert(1)"/>');
  expect(
    (await f.request("image.svg", "content&inline=true")).headers.get("content-disposition"),
  ).toContain("attachment;");
  writeFileSync(join(f.cwd, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  expect(((await (await f.request("binary.bin", "content&preview=true")).json()) as any).kind).toBe(
    "binary",
  );
  writeFileSync(join(f.cwd, "empty.txt"), "");
  expect(await (await f.request("empty.txt", "content")).text()).toBe("");
});

test("staged attachments remain reachable without exposing workspace settings", async () => {
  const f = await fixture();
  mkdirSync(join(f.cwd, ".code-shell/attachments/session"), { recursive: true });
  writeFileSync(join(f.cwd, ".code-shell/attachments/session/file.txt"), "Uploaded file");
  expect(
    await (await f.request(".code-shell/attachments/session/file.txt", "content")).text(),
  ).toBe("Uploaded file");
});

test("large directories return a bounded, explicitly truncated page and private names are case-insensitive", async () => {
  const f = await fixture();
  for (let index = 0; index < 520; index++) writeFileSync(join(f.cwd, `file-${index}.txt`), "ok");
  mkdirSync(join(f.cwd, ".CODE-SHELL"));
  writeFileSync(join(f.cwd, ".CODE-SHELL/settings.json"), "private");
  writeFileSync(join(f.cwd, ".ENV.production"), "private");
  const listing = await (await f.request("")).json();
  expect(listing.files).toHaveLength(500);
  expect(listing.truncated).toBe(true);
  expect(listing.files.every((entry: any) => entry.name.startsWith("file-"))).toBe(true);
  expect((await f.request(".CODE-SHELL/settings.json", "content")).status).toBe(403);
  expect((await f.request(".ENV.production", "content")).status).toBe(403);
});

test("a directory replaced during the authorization recheck cannot redirect an opened file", async () => {
  const f = await fixture((cwd, call) => {
    if (call === 2) {
      renameSync(join(cwd, "documents"), join(cwd, "parked"));
      symlinkSync(join(cwd, "outside"), join(cwd, "documents"));
    }
    return true;
  });
  mkdirSync(join(f.cwd, "documents"));
  mkdirSync(join(f.cwd, "outside"));
  writeFileSync(join(f.cwd, "documents/file.txt"), "safe bytes");
  writeFileSync(join(f.cwd, "outside/file.txt"), "must not leak");
  const response = await f.request("documents/file.txt", "content");
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("must not leak");
});

test("revocation before bytes are returned rejects the download", async () => {
  const f = await fixture((_cwd, call) => call === 1);
  writeFileSync(join(f.cwd, "file.txt"), "private bytes");
  const response = await f.request("file.txt", "content");
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("private bytes");
});
