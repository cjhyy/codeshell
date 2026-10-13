import { fileURLToPath } from "node:url";
import { test, expect, afterAll } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "cs-review-files-history-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
let files: any;
let history: any;
const server = createServer(async (req, res) => {
  if (await files.handle(req, res)) return;
  if (await history.handle(req, res)) return;
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const { installLocalNetworkGuard } = await import(
  repo + "/scripts/runtime-cost-smoke-isolation.mjs"
);
installLocalNetworkGuard(origin);
// All production Core/Host imports occur after the exact local fixture guard.
const { createHubFiles } = await import(repo + "/packages/server/src/hub/files.ts");
const { createHubSessions } = await import(repo + "/packages/server/src/hub/session-management.ts");
const { SessionManager } = await import(repo + "/packages/core/dist/index.js");
const sessionRootDir = join(root, "sessions");
const dataDir = join(root, "hub");
const manager = new SessionManager(sessionRootDir);
const running = new Set<string>();
const changed: string[] = [];
const options = {
  cwd,
  sessionRootDir,
  dataDir,
  isAuthorized: async () => true,
  isRunning: (id: string) => running.has(id),
  onChanged: (id: string) => changed.push(id),
};
files = createHubFiles(options);
history = createHubSessions(options);
const json = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(origin + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json(),
    headers: Object.fromEntries(response.headers),
  };
};
const outputs: Record<string, unknown> = {};
afterAll(async () => {
  writeFileSync(
    new URL("./daily-contracts-observed.json", import.meta.url),
    JSON.stringify(outputs, null, 2),
  );
  files.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  rmSync(root, { recursive: true, force: true });
});

test("daily file navigation, Unicode preview/download, empty files, and bounded text preview", async () => {
  mkdirSync(join(cwd, "documents"));
  const content = "报告 #1\nASCII, 中文, emoji 🐈.\n";
  writeFileSync(join(cwd, "documents", "报告 #1.txt"), content);
  writeFileSync(join(cwd, "empty.txt"), "");
  writeFileSync(join(cwd, "large.txt"), "abc\n".repeat(150_000));
  const listing = await json("/api/v1/files");
  expect(listing.status).toBe(200);
  expect(listing.body.files[0]).toMatchObject({
    name: "documents",
    path: "documents",
    kind: "directory",
  });
  const nested = await json("/api/v1/files?path=documents");
  expect(nested.body.path).toBe("documents");
  expect(nested.body.files[0].path).toBe("documents/报告 #1.txt");
  const filePath = encodeURIComponent(nested.body.files[0].path);
  const preview = await json(`/api/v1/files/content?path=${filePath}&preview=true`);
  expect(preview.body).toMatchObject({ kind: "text", content, truncated: false });
  const download = await fetch(`${origin}/api/v1/files/content?path=${filePath}`);
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer())).toEqual(
    readFileSync(join(cwd, "documents", "报告 #1.txt")),
  );
  expect(download.headers.get("content-disposition")).toContain("filename*=UTF-8''");
  const empty = await fetch(`${origin}/api/v1/files/content?path=empty.txt`);
  expect(empty.status).toBe(200);
  expect(await empty.text()).toBe("");
  const large = await json("/api/v1/files/content?path=large.txt&preview=true");
  expect(large.body.truncated).toBe(true);
  expect(Buffer.byteLength(large.body.content)).toBe(512 * 1024);
  outputs.files = {
    paths: listing.body.files.map((entry: any) => entry.path),
    nestedPath: nested.body.path,
    unicodePreviewMatchesDownload: true,
    emptyDownloadBytes: 0,
    previewBytes: Buffer.byteLength(large.body.content),
  };
});

test("history search, tie-safe pagination, rename/archive persistence, and actual exports", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 52; i++) {
    const { state, transcript } = manager.create(cwd, "fixture", "fixture");
    ids.push(state.sessionId);
    transcript.append("message", { role: "user", content: `Daily task ${i}` });
    transcript.append("message", { role: "assistant", content: `Recorded answer ${i}` });
    manager.updateSessionState(state.sessionId, { title: `Review session ${i}` });
    utimesSync(join(sessionRootDir, state.sessionId, "transcript.jsonl"), 100, 100);
  }
  const first = await json("/api/v1/sessions?limit=50");
  expect(first.status).toBe(200);
  expect(first.body.sessions).toHaveLength(50);
  const second = await json(
    "/api/v1/sessions?limit=50&cursor=" + encodeURIComponent(first.body.nextCursor),
  );
  expect(second.body.sessions).toHaveLength(2);
  const returned = [...first.body.sessions, ...second.body.sessions].map(
    (entry: any) => entry.sessionId,
  );
  expect(new Set(returned).size).toBe(52);
  expect([...returned].sort()).toEqual([...ids].sort());
  const id = ids[0];
  expect(
    (await json(`/api/v1/sessions/${id}`, "PATCH", { title: "部署记录 #42", expectedTitle: "" }))
      .status,
  ).toBe(200);
  const searched = await json("/api/v1/sessions?query=" + encodeURIComponent("部署记录"));
  expect(searched.body.sessions.map((entry: any) => entry.sessionId)).toEqual([id]);
  expect((await json(`/api/v1/sessions/${id}`, "PATCH", { archived: true })).status).toBe(200);
  history = createHubSessions(options);
  const archived = await json("/api/v1/sessions?archived=true");
  expect(archived.body.sessions[0]).toMatchObject({
    sessionId: id,
    title: "部署记录 #42",
    customTitle: "部署记录 #42",
  });
  const current = await json("/api/v1/sessions?limit=100");
  expect(current.body.sessions).toHaveLength(51);
  const markdown = await fetch(`${origin}/api/v1/sessions/${id}/export`);
  expect(markdown.status).toBe(200);
  const markdownText = await markdown.text();
  expect(markdownText).toContain("# 部署记录 #42");
  expect(markdownText).toContain("Daily task 0");
  expect(markdownText).toContain("Recorded answer 0");
  const raw = await json(`/api/v1/sessions/${id}/export?format=json`);
  expect(raw.body.version).toBe(1);
  expect(
    raw.body.transcript.some((record: any) => record.data?.content === "Recorded answer 0"),
  ).toBe(true);
  running.add(id!);
  expect((await json(`/api/v1/sessions/${id}/export`)).status).toBe(409);
  expect((await json(`/api/v1/sessions/${id}`, "PATCH", { archived: false })).status).toBe(409);
  running.delete(id!);
  expect((await json(`/api/v1/sessions/${id}`, "PATCH", { archived: false })).status).toBe(200);
  outputs.history = {
    firstPage: first.body.sessions.length,
    secondPage: second.body.sessions.length,
    uniqueIds: new Set(returned).size,
    sameTimestampPagination: true,
    searchIds: searched.body.sessions.map((entry: any) => entry.sessionId),
    archiveAndTitlePersistedAcrossServiceReopen: true,
    markdownContainsUserAndAssistant: true,
    runningExportStatus: 409,
    runningRestoreStatus: 409,
    changes: changed.length,
  };
});
