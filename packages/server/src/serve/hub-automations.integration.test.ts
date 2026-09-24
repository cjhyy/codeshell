import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  SessionManager,
  installReviewedLocalPanelApp,
  previewLocalPanelApp,
} from "@cjhyy/code-shell-core";
import { startHeadlessServer, type HeadlessServer } from "./headless-server.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw Error(`Timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}

test("Hub HTTP automation owns a real shared Worker Session across logout, competing runs and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "hub-automation-real-"));
  const priorHome = process.env.HOME;
  const cwd = join(root, "project"),
    source = join(root, "panel"),
    dataDir = join(root, "data");
  process.env.HOME = join(root, "home");
  const gate = deferred(),
    entered = deferred();
  const proof = join(cwd, "automation-proof.txt");
  const errors: unknown[] = [];
  let first = true,
    writes = 0;
  let server: HeadlessServer | undefined;
  const sockets: WebSocket[] = [];
  const model = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (first && body.tools?.length) {
        first = false;
        entered.resolve();
        await gate.promise;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "hub-fixture", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (body.tools?.length && !body.messages.some((message: any) => message.role === "tool")) {
        writes++;
        frame({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "write-result",
              type: "function",
              function: {
                name: "Write",
                arguments: JSON.stringify({
                  file_path: proof,
                  content: "cloud automation completed\n",
                }),
              },
            },
          ],
        });
        frame({}, "tool_calls");
      } else {
        frame({ role: "assistant", content: "Automation result saved." });
        frame({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    })().catch((error) => {
      errors.push(error);
      res.destroy();
    });
  });
  try {
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    mkdirSync(join(source, ".codeshell-panel"), { recursive: true });
    mkdirSync(join(source, "app"));
    writeFileSync(
      join(source, "app/index.html"),
      "<!doctype html><html><head></head><body>automation</body></html>",
    );
    writeFileSync(
      join(source, ".codeshell-panel/panel.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "automation-fixture",
        title: { default: "Automation" },
        version: "1.0.0",
        entry: "app/index.html",
        icon: "panel",
        placement: "right-dock",
        singleton: true,
        permissions: ["context.workspace", "context.session", "automations.manage"],
      }),
    );
    const input = { kind: "dir" as const, path: source };
    const preview = await previewLocalPanelApp(input);
    await installReviewedLocalPanelApp(input, preview.reviewToken, new Date().toISOString());
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const port = (model.address() as { port: number }).port;
    writeFileSync(
      join(cwd, ".code-shell/settings.local.json"),
      JSON.stringify({
        credentials: [
          {
            id: "fixture-key",
            catalogId: "openai",
            apiKey: "fixture",
            baseUrl: `http://127.0.0.1:${port}/v1`,
          },
        ],
        modelConnections: [
          {
            id: "automation-fixture",
            catalogId: "openai",
            tag: "text",
            model: "gpt-4o-mini",
            credentialId: "fixture-key",
          },
        ],
        defaults: { text: "automation-fixture" },
        permissions: { defaultMode: "default", rules: [{ tool: "Write", decision: "ask" }] },
        autoUpdates: false,
      }),
    );
    const options = {
      cwd,
      dataDir,
      workerEntryPath: createRequire(import.meta.url).resolve(
        "@cjhyy/code-shell-core/bin/agent-server-stdio",
      ),
      execPath: "node",
      authMode: "hub" as const,
      port: 0,
      workerCapabilityModules: `${import.meta.resolve("@cjhyy/code-shell-capability-coding")}#createCodingModule`,
    };
    const sessionManager = new SessionManager(join(dataDir, "worker/sessions"));
    const sessionId = sessionManager.create(cwd, "gpt-4o-mini", "openai").state.sessionId;
    server = await startHeadlessServer(options);
    let cookie = "";
    const api = (path: string, method = "GET", body?: unknown) =>
      fetch(server!.url + path, {
        method,
        headers: { cookie, origin: server!.url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const setup = await api("/api/v1/auth/setup", "POST", {
      token: server.bootstrapToken,
      username: "tester",
      password: "automation-password-123",
    });
    expect(setup.status).toBe(200);
    cookie = setup.headers.get("set-cookie")!.split(";", 1)[0]!;
    const catalog = (await (await api("/api/v1/panels")).json()) as any;
    const binding = await api("/api/v1/panels/automation-fixture/binding", "PATCH", {
      bound: true,
      expectedRevision: catalog.panels[0].revision,
    });
    expect(binding.status).toBe(200);
    const latest = (await binding.json()) as any;
    const prepare = async () => {
      const response = await api("/api/v1/panels/runtime/prepare", "POST", {
        appId: "automation-fixture",
        revision: latest.panels[0].revision,
        sessionId,
      });
      const body = (await response.json()) as any;
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.context.availableMethods).toContain("automations.createUnique");
      expect(body.context.availableMethods).toContain("automations.updateIfRevision");
      expect(body.context.availableMethods).toContain("automations.deleteIfRevision");
      return `/api/v1/panels/runtime/${body.instanceId}/call`;
    };
    let endpoint = await prepare();
    const call = async (method: string, params?: unknown) => {
      const response = await api(endpoint, "POST", { method: `automations.${method}`, params });
      const body = (await response.json()) as any;
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body;
    };
    const definition = {
      name: "Cloud check",
      prompt: "Write the proof file.",
      schedule: "1d",
      key: "daily-check",
    };
    const created = await call("createUnique", definition);
    const job = created.result ?? created;
    expect(typeof job.id, JSON.stringify(created)).toBe("string");
    const replayed = await call("createUnique", definition);
    expect((replayed.result ?? replayed).id).toBe(job.id);
    const edited = await call("updateIfRevision", {
      id: job.id,
      expectedRevision: job.revision,
      prompt: "Write the proof file once.",
    });
    expect(edited.ok).toBe(true);
    expect(await call("deleteIfRevision", { id: job.id, expectedRevision: job.revision })).toEqual({
      ok: false,
      conflict: true,
    });
    expect(
      await call("updateIfRevision", {
        id: job.id,
        expectedRevision: job.revision,
        prompt: "stale",
      }),
    ).toEqual({ ok: false, conflict: true });
    await call("runNow", { id: job.id });
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered.promise,
        new Promise((_, reject) => {
          admissionTimer = setTimeout(() => reject(Error("model not reached")), 15000);
        }),
      ]);
    } finally {
      clearTimeout(admissionTimer);
    }
    const socket = new WebSocket(server.url.replace("http", "ws") + "/ws", {
      headers: { cookie, origin: server.url },
    });
    sockets.push(socket);
    const messages: any[] = [];
    socket.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)));
    });
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "competing-run",
        method: "agent/run",
        params: { sessionId, task: "Do not interleave this turn." },
      }),
    );
    const busy = await until(
      async () => messages.find((value) => value.id === "competing-run"),
      Boolean,
    );
    expect(busy.error.code).toBe(-32009);
    expect((await api(`/api/v1/sessions/${sessionId}`, "PATCH", { archived: true })).status).toBe(
      409,
    );
    const snapshot = JSON.parse(
      readFileSync(join(dataDir, "panel-automations/records/cron.json"), "utf8"),
    );
    expect(snapshot.jobs[0].lastExecution.status).toBe("running");
    expect(snapshot.jobs[0].lastExecution.id).toBe(snapshot.jobs[0].lastRunId);
    expect((await api("/api/v1/auth/logout", "POST", {})).status).toBe(200);
    const login = await api("/api/v1/auth/login", "POST", {
      username: "tester",
      password: "automation-password-123",
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    endpoint = await prepare();
    gate.resolve();
    const completed = await until(
      async () => {
        const value = await call("list");
        return (value.result ?? value).automations[0];
      },
      (value) => value.lastExecution?.status === "completed",
    );
    expect(readFileSync(proof, "utf8")).toBe("cloud automation completed\n");
    expect(completed.id).toBe(job.id);
    expect(completed.runCount).toBe(1);
    expect(writes).toBe(1);
    expect(errors).toEqual([]);
    for (const socket of sockets.splice(0)) socket.terminate();
    await server.close();
    server = await startHeadlessServer(options);
    const relogin = await api("/api/v1/auth/login", "POST", {
      username: "tester",
      password: "automation-password-123",
    });
    cookie = relogin.headers.get("set-cookie")!.split(";", 1)[0]!;
    endpoint = await prepare();
    const restoredResponse = await call("list");
    const restored = restoredResponse.result ?? restoredResponse;
    expect(restored.automations[0].lastExecution).toEqual(completed.lastExecution);
    expect(restored.automations[0].runCount).toBe(1);
    expect(server.bridge.hasChild()).toBe(false);
  } finally {
    gate.resolve();
    for (const socket of sockets) socket.terminate();
    await server?.close();
    model.closeAllConnections();
    await new Promise<void>((done) => model.close(() => done()));
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 45000);
