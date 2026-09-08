import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import {
  createHubSessions,
  transcriptMarkdown,
  readHubTranscript,
  readHubSessionState,
} from "./session-management.js";

const fixtures: Array<{ root: string; server: Server }> = [];
afterEach(async () => {
  for (const { root, server } of fixtures.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-hub-sessions-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const manager = new SessionManager(join(root, "sessions"));
  const changed: string[] = [];
  const running = new Set<string>();
  const service = createHubSessions({
    cwd,
    sessionRootDir: join(root, "sessions"),
    dataDir: join(root, "hub"),
    isAuthorized: async (req) => req.headers.authorization === "Bearer fixture",
    isRunning: (id) => running.has(id),
    onChanged: (id) => changed.push(id),
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
  fixtures.push({ root, server });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/v1/sessions`;
  const request = (path = "", method = "GET", body?: unknown, authorized = true) =>
    fetch(url + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: "Bearer fixture" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { root, cwd, manager, changed, running, service, request };
}

test("session titles persist separately from engine titles, search and archive remain workspace scoped", async () => {
  const f = await fixture();
  const { state } = f.manager.create(f.cwd, "model", "provider");
  f.manager.updateSessionState(state.sessionId, { title: "Generated title" });
  f.manager.create(join(f.root, "elsewhere"), "model", "provider");
  expect((await f.request("", "GET", undefined, false)).status).toBe(401);
  expect((await f.request(`/${state.sessionId}`, "PATCH", { title: "部署记录" })).status).toBe(200);
  expect(f.manager.readSessionState(state.sessionId)?.title).toBe("Generated title");
  const found = (await (await f.request("?query=" + encodeURIComponent("部署"))).json()) as any;
  expect(found.sessions).toHaveLength(1);
  expect(found.sessions[0].title).toBe("部署记录");
  expect((await f.request(`/${state.sessionId}`, "PATCH", { archived: true })).status).toBe(200);
  expect(((await (await f.request()).json()) as any).sessions).toHaveLength(0);
  expect(((await (await f.request("?archived=true")).json()) as any).sessions[0].title).toBe(
    "部署记录",
  );
  expect(f.manager.readSessionArchivedAt(state.sessionId)).toBeGreaterThan(0);
  expect((await f.request(`/${state.sessionId}`, "PATCH", { archived: false })).status).toBe(200);
  expect(f.changed).toEqual([state.sessionId, state.sessionId, state.sessionId]);
  const disk = JSON.parse(readFileSync(join(f.root, "hub/session-titles.json"), "utf8"));
  expect(disk[state.sessionId]).toBe("部署记录");
});

test("running, invalid and foreign session mutations cannot corrupt or hide history", async () => {
  const f = await fixture();
  const own = f.manager.create(f.cwd, "model", "provider").state.sessionId;
  const foreign = f.manager.create(join(f.root, "elsewhere"), "model", "provider").state.sessionId;
  f.running.add(own);
  expect((await f.request(`/${own}`, "PATCH", { archived: true })).status).toBe(409);
  expect((await f.request(`/${own}/export`)).status).toBe(409);
  expect((await f.request(`/${foreign}`, "PATCH", { title: "escape" })).status).toBe(404);
  expect((await f.request(`/${own}`, "PATCH", { title: "hello\nheader" })).status).toBe(400);
  expect((await f.request(`/${own}`, "PATCH", { title: "valid", archived: true })).status).toBe(
    400,
  );
  expect((await f.request("?limit=0")).status).toBe(400);
  expect((await f.request("?cursor=bad")).status).toBe(400);
  expect(f.manager.readSessionArchivedAt(own)).toBeUndefined();
  expect(f.changed).toHaveLength(0);
});

test("two devices cannot silently replace a title changed after their snapshot", async () => {
  const f = await fixture();
  const id = f.manager.create(f.cwd, "model", "provider").state.sessionId;
  const first = await f.request(`/${id}`);
  expect(first.status).toBe(200);
  expect((await first.json()).customTitle).toBe("");

  const updates = await Promise.all([
    f.request(`/${id}`, "PATCH", { title: "Device A", expectedTitle: null }),
    f.request(`/${id}`, "PATCH", { title: "Device B", expectedTitle: "" }),
  ]);
  expect(updates.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(await updates.find((response) => response.status === 409)!.text()).toContain("另一设备");
  expect(f.changed).toEqual([id]);
  const latest = await (await f.request(`/${id}`)).json();
  expect(["Device A", "Device B"]).toContain(latest.title);
  expect(latest.customTitle).toBe(latest.title);
  expect(latest.transcript).toBeUndefined();

  expect(
    (
      await f.request(`/${id}`, "PATCH", {
        title: "Reviewed replacement",
        expectedTitle: latest.customTitle,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.request(`/${id}`, "PATCH", {
        title: "",
        expectedTitle: latest.customTitle,
      })
    ).status,
  ).toBe(409);
  expect((await (await f.request(`/${id}`)).json()).customTitle).toBe("Reviewed replacement");
  // Existing clients keep their original unconditional title API.
  expect((await f.request(`/${id}`, "PATCH", { title: "Legacy update" })).status).toBe(200);
  expect(
    (
      await f.request(`/${id}`, "PATCH", {
        title: "",
        expectedTitle: "Legacy update",
      })
    ).status,
  ).toBe(200);
  expect((await (await f.request(`/${id}`)).json()).customTitle).toBe("");
});

test("title detail and compare-and-set preserve workspace scope and reject malformed expectations", async () => {
  const f = await fixture();
  const id = f.manager.create(f.cwd, "model", "provider").state.sessionId;
  const foreign = f.manager.create(join(f.root, "elsewhere"), "model", "provider").state.sessionId;
  expect((await f.request(`/${id}`, "GET", undefined, false)).status).toBe(401);
  expect((await f.request(`/${foreign}`)).status).toBe(404);
  for (const expectedTitle of [false, 1, {}, [], "\0", "x".repeat(1025)]) {
    expect((await f.request(`/${id}`, "PATCH", { title: "Draft", expectedTitle })).status).toBe(
      400,
    );
  }
  expect((await f.request(`/${id}`, "PATCH", { archived: true, expectedTitle: "" })).status).toBe(
    400,
  );
  expect(
    (await f.request(`/${id}`, "PATCH", { title: "Draft", expectedTitle: "", extra: true })).status,
  ).toBe(400);
  expect(f.changed).toHaveLength(0);
  expect((await f.request(`/${id}`, "PATCH", { archived: true })).status).toBe(200);
  expect((await (await f.request()).json()).sessions).toHaveLength(0);
  expect((await (await f.request(`/${id}`)).json()).archivedAt).toBeGreaterThan(0);
  expect(
    (await f.request(`/${id}`, "PATCH", { title: "Archived draft", expectedTitle: "" })).status,
  ).toBe(200);
  rmSync(join(f.root, "sessions", id), { recursive: true });
  expect((await f.request(`/${id}`)).status).toBe(404);
  expect(
    (
      await f.request(`/${id}`, "PATCH", {
        title: "Retained draft",
        expectedTitle: "Archived draft",
      })
    ).status,
  ).toBe(404);
});

test("exports use actual raw transcript data and shared browser projection", async () => {
  const f = await fixture();
  const { state, transcript } = f.manager.create(f.cwd, "model", "provider");
  transcript.append("message", { role: "user", content: "Export this conversation" });
  transcript.append("message", {
    role: "assistant",
    content: [{ type: "text", text: "A complete answer." }],
  });
  const markdown = await f.request(`/${state.sessionId}/export`);
  expect(markdown.status).toBe(200);
  expect(markdown.headers.get("content-disposition")).toContain("attachment;");
  expect(markdown.headers.get("cache-control")).toBe("no-store");
  const content = await markdown.text();
  expect(content).toContain("Export this conversation");
  expect(content).toContain("A complete answer.");
  const json = (await (await f.request(`/${state.sessionId}/export?format=json`)).json()) as any;
  expect(json.version).toBe(1);
  expect(json.transcript.some((record: any) => record.data?.role === "assistant")).toBe(true);
  writeFileSync(
    join(f.root, "sessions", state.sessionId, "transcript.jsonl"),
    "x".repeat(32 * 1024 * 1024 + 1),
  );
  expect((await f.request(`/${state.sessionId}/export`)).status).toBe(413);
});

test("Markdown tool results cannot terminate their own code fence", () => {
  const markdown = transcriptMarkdown("Fixture", [
    { type: "tool_use", data: { toolCallId: "call", toolName: "Read", args: { file: "sample" } } },
    { type: "tool_result", data: { toolCallId: "call", result: "```\nembedded fence\n```" } },
  ]);
  expect(markdown).toContain("````\n```\nembedded fence\n```\n````");
});

test("bounded transcript snapshots have no permission or state side effects and retain a valid append prefix", async () => {
  const f = await fixture();
  const { state, transcript } = f.manager.create(f.cwd, "model", "provider");
  transcript.append("message", { role: "user", content: "durable prefix" });
  const transcriptFile = join(f.root, "sessions", state.sessionId, "transcript.jsonl");
  const stateFile = join(f.root, "sessions", state.sessionId, "state.json");
  const raw = readFileSync(transcriptFile, "utf8");
  const originalState = readFileSync(stateFile, "utf8");
  if (process.platform !== "win32") chmodSync(transcriptFile, 0o640);
  const mode = statSync(transcriptFile).mode;
  writeFileSync(transcriptFile, raw + '{"type":"message","data":');
  expect(readHubTranscript(join(f.root, "sessions"), state.sessionId)).toHaveLength(2);
  expect(statSync(transcriptFile).mode).toBe(mode);
  expect(readFileSync(stateFile, "utf8")).toBe(originalState);
  writeFileSync(transcriptFile, raw + "invalid record\n");
  expect(() => readHubTranscript(join(f.root, "sessions"), state.sessionId)).toThrow("损坏");
  expect((await f.request(`/${state.sessionId}/export`)).status).toBe(422);
});

test("transcript and state symlinks cannot escape the session storage boundary", async () => {
  const f = await fixture();
  const { state } = f.manager.create(f.cwd, "model", "provider");
  const outside = join(f.root, "outside.jsonl");
  writeFileSync(outside, '{"type":"message","data":{"role":"user","content":"secret outside"}}\n');
  const transcript = join(f.root, "sessions", state.sessionId, "transcript.jsonl");
  rmSync(transcript);
  symlinkSync(outside, transcript);
  const response = await f.request(`/${state.sessionId}/export?format=json`);
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("secret outside");
  const stateFile = join(f.root, "sessions", state.sessionId, "state.json");
  rmSync(stateFile);
  symlinkSync(outside, stateFile);
  expect(() => readHubSessionState(join(f.root, "sessions"), state.sessionId)).toThrow();
  expect((await f.request(`/${state.sessionId}`, "PATCH", { title: "escape" })).status).toBe(404);
});

test("engine attachment wrappers do not leak through title, preview, search or Markdown exports", async () => {
  const f = await fixture();
  const { state, transcript } = f.manager.create(f.cwd, "model", "provider");
  const wrapper =
    '<attached-file path=".code-shell/attachments/session/aaaaaaaaaaaaaaaa-report.txt">\nabsolutePath: /private/internal/path/report.txt\norigin: upload\nsize: 5\nmime: text/plain\n</attached-file>\nVisible request';
  transcript.append("message", { role: "user", content: wrapper });
  f.manager.updateSessionState(state.sessionId, { title: { malformed: true } as any });
  const list = await (await f.request()).json();
  expect(list.sessions[0].title).toBe("Visible request");
  expect(list.sessions[0].preview).toBe("Visible request");
  expect((await (await f.request("?query=internal%2Fpath")).json()).sessions).toHaveLength(0);
  expect((await (await f.request("?query=Visible")).json()).sessions).toHaveLength(1);
  const markdown = transcriptMarkdown("Fixture", [
    { type: "message", data: { role: "user", content: wrapper } },
  ]);
  expect(markdown).toContain("Visible request");
  expect(markdown).toContain("附件：report.txt");
  expect(markdown).not.toContain("absolutePath");
  expect(markdown).not.toContain("/private/internal/path");
});

test("Markdown exports bound fence scanning without a spread-argument overflow", () => {
  const markdown = transcriptMarkdown("Fixture", [
    { type: "tool_use", data: { toolCallId: "many", toolName: "Read", args: {} } },
    { type: "tool_result", data: { toolCallId: "many", result: "`x".repeat(200_000) } },
  ]);
  expect(markdown).toContain("```\n`x`x");
});
