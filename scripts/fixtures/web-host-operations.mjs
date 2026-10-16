/** Actual compiled CLI + stdio Engine Worker and an owned loopback SSE provider. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../bun-test-completion.mjs";
import { confinedWorkerEnvironment } from "../runtime-cost-smoke-isolation.mjs";
import { createWebHostProcessCustody } from "./web-host-process-custody.mjs";

export async function waitFor(check, label, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function createWebHostOperationsFixture() {
  const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeshell-web-real-host-")));
  const clean = createBunTestEnvironment(process.env, root);
  const workspace = join(clean.HOME, "workspace");
  const data = join(clean.HOME, "host-data");
  const evidence = join(root, "evidence");
  await Promise.all(
    [workspace, data, evidence].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  const webRoot = join(repository, "packages/web/dist-app");
  const html = await readFile(join(webRoot, "index.html"), "utf8");
  const artifactPaths = [
    "packages/core/dist/cli/agent-server-stdio.js",
    "packages/server/dist/bin/code-shell-serve.js",
    "packages/server/dist/serve/headless-server.js",
    "packages/web/dist-app/index.html",
    ...[...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
      (match) => "packages/web/dist-app/" + match[1].replace(/^\.?\//, ""),
    ),
  ];
  const artifactHashes = [];
  for (const path of artifactPaths) {
    const absolute = await realpath(join(repository, path));
    assert(absolute.startsWith(repository + "/"), "Every built artifact belongs to this worktree");
    artifactHashes.push({
      path,
      sha256: createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex"),
    });
  }
  const requests = [],
    faults = [];
  const streams = new Set();
  let reconnectStream;
  const frame = (model, text, finishReason = null) => ({
    id: "owned-web-host",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finishReason }],
  });
  const write = (res, model, text) => res.write(`data: ${JSON.stringify(frame(model, text))}\n\n`);
  const finish = (res, model, text) => {
    if (text) write(res, model, text);
    res.end(`data: ${JSON.stringify(frame(model, null, "stop"))}\n\ndata: [DONE]\n\n`);
  };
  const provider = createServer((req, res) => {
    void (async () => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer owned-local-provider-key");
      const parts = [];
      for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (body.stream !== true) {
        const system = body.messages.find((message) => message.role === "system");
        const user = body.messages.find((message) => message.role === "user");
        assert(
          JSON.stringify(system?.content).includes("You generate a very short title"),
          "Only the production session-title auxiliary prompt is accepted",
        );
        const input = typeof user?.content === "string" ? user.content : "";
        const firstTurn = ["OWNED_INIT_A", "OWNED_INIT_B"].find(
          (marker) => input === `User: ${marker}\n\nAssistant: Saved ${marker}.\n\nTitle:`,
        );
        assert(firstTurn, "Auxiliary title must match the exact first user/assistant turn");
        requests.push({
          marker: firstTurn === "OWNED_INIT_A" ? "OWNED_TITLE_A" : "OWNED_TITLE_B",
          body,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "owned-title",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: input.includes("OWNED_INIT_B") ? "OWNED_INIT_B" : "OWNED_INIT_A",
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
        return;
      }
      const user = body.messages.findLast(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("OWNED_"),
      );
      const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
      const marker = ["OWNED_INIT_A", "OWNED_INIT_B", "OWNED_UPLOAD_A", "OWNED_RECONNECT"].find(
        (m) => text?.includes(m),
      );
      assert(marker, "The local provider only accepts this fixture's four user turns");
      requests.push({ marker, body });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (marker === "OWNED_RECONNECT") {
        streams.add(res);
        res.once("close", () => streams.delete(res));
        reconnectStream = { res, model: body.model };
        write(res, body.model, "Owned stream first. ");
      } else
        finish(
          res,
          body.model,
          marker === "OWNED_UPLOAD_A" ? "Owned attachment accepted." : `Saved ${marker}.`,
        );
    })().catch((error) => {
      faults.push(String(error));
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  const nonce = randomUUID();
  const receiptsPath = join(clean.HOME, "network-process-receipts.jsonl");
  let child, custody, monitor, monitorFailure, spawnFailure;
  let logs = "",
    serial = 0;
  const messages = [];
  const control = async (action) => {
    const id = ++serial;
    child.send({ nonce, id, action });
    return (
      await waitFor(
        () => messages.find((message) => message.id === id),
        `Host control ${action}`,
        5000,
      )
    ).result;
  };
  const close = async () => {
    const failures = [];
    let remaining = null;
    try {
      for (const res of streams) res.destroy();
      try {
        custody?.observe();
      } catch (error) {
        failures.push(error);
      }
      if (child && !spawnFailure && child.exitCode === null && child.signalCode === null) {
        // The private IPC pipe identifies this child independently of PID reuse.
        // Main receives its existing production SIGTERM shutdown event.
        try {
          await new Promise((resolve, reject) =>
            child.send({ nonce, action: "shutdown-host" }, (error) =>
              error ? reject(error) : resolve(),
            ),
          );
        } catch (error) {
          failures.push(error);
          custody?.signal("SIGTERM");
        }
        try {
          await waitFor(
            () => child.exitCode !== null || child.signalCode !== null || spawnFailure,
            "owned Host graceful shutdown",
            5000,
          );
        } catch {
          assert(custody, "Cannot escalate without captured process custody");
          custody.signal("SIGKILL");
          await waitFor(
            () => child.exitCode !== null || child.signalCode !== null,
            "owned Host identity-checked escalation",
            3000,
          );
        }
      }
      if (custody) {
        if (custody.remaining().length) {
          custody.signal("SIGTERM");
          try {
            await waitFor(
              () => !custody.remaining().length,
              "observed descendants graceful shutdown",
              2000,
            );
          } catch {
            custody.signal("SIGKILL");
            await waitFor(
              () => !custody.remaining().length,
              "observed descendants identity-checked escalation",
              3000,
            );
          }
        }
        remaining = custody.remaining();
        assert.equal(
          remaining.length,
          0,
          "Every observed original process incarnation must terminate",
        );
      }
      if (monitorFailure) throw monitorFailure;
    } catch (error) {
      failures.push(error);
    } finally {
      clearInterval(monitor);
      try {
        provider.closeAllConnections();
        if (provider.listening)
          await new Promise((resolve, reject) =>
            provider.close((error) => (error ? reject(error) : resolve())),
          );
      } catch (error) {
        failures.push(error);
      }
      try {
        await writeFile(
          join(evidence, "cleanup.json"),
          JSON.stringify(
            {
              passed: failures.length === 0,
              custody: custody?.evidence() ?? null,
              remaining,
              providerClosed: !provider.listening,
              failures: failures.map(String),
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Owned Host/provider cleanup failed");
  };
  try {
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
    const settings = JSON.parse(
      await readFile(join(repository, "deploy/settings.example.json"), "utf8"),
    );
    settings.credentials[0].apiKey = "owned-local-provider-key";
    settings.credentials[0].baseUrl = providerOrigin + "/v1";
    settings.modelConnections[0].model = "gpt-4o-mini";
    await mkdir(join(workspace, ".code-shell"), { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, ".code-shell/settings.local.json"), JSON.stringify(settings), {
      mode: 0o600,
    });
    const env = {
      ...confinedWorkerEnvironment(
        clean,
        clean.HOME,
        providerOrigin,
        new URL("./web-host-operations-guard.mjs", import.meta.url).href,
      ),
      CODESHELL_WEB_HOST_RECEIPTS: receiptsPath,
      CODESHELL_WEB_HOST_CONTROL: nonce,
      CODESHELL_SELF_UPDATE_CHECK: "0",
    };
    const entry = join(repository, "packages/server/dist/bin/code-shell-serve.js");
    child = spawn(
      process.execPath,
      [
        entry,
        "--auth",
        "hub",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--cwd",
        workspace,
        "--data-dir",
        data,
        "--static-root",
        join(repository, "packages/web/dist-app"),
      ],
      {
        cwd: workspace,
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: process.platform !== "win32",
      },
    );
    child.on("error", (error) => {
      spawnFailure = error;
    });
    child.on("message", (message) => messages.push(message));
    child.stdout.on("data", (part) => {
      logs = (logs + part).slice(-60_000);
    });
    child.stderr.on("data", (part) => {
      logs = (logs + part).slice(-60_000);
    });
    custody = createWebHostProcessCustody(child);
    monitor = setInterval(() => {
      try {
        custody.observe();
      } catch (error) {
        monitorFailure ??= error;
      }
    }, 250);
    const url = await waitFor(
      () => {
        if (spawnFailure) throw spawnFailure;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Owned Host startup exited: ${logs}`);
        return /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
      },
      "actual Host startup",
      20_000,
    );
    const token = await waitFor(
      () => /#setup=([A-Za-z0-9_-]+)/.exec(logs)?.[1],
      "owned bootstrap token",
      5000,
    );
    return {
      repository,
      root,
      evidence,
      workspace,
      data,
      clean,
      providerOrigin,
      url,
      token,
      hostPid: child.pid,
      requests,
      faults,
      control,
      close,
      waitUpload: () =>
        waitFor(
          () => messages.some((m) => m.kind === "upload-held"),
          "actual 201 upload response held",
        ),
      middle: () => {
        assert(reconnectStream);
        write(reconnectStream.res, reconnectStream.model, "Owned stream missed middle. ");
      },
      finish: () => {
        assert(reconnectStream);
        finish(reconnectStream.res, reconnectStream.model, "Owned stream final.");
      },
      receipts: async () =>
        (await readFile(receiptsPath, "utf8")).trim().split("\n").map(JSON.parse),
      sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      artifactHashes,
      safeLogs: () => logs.replaceAll(token, "[owned-bootstrap-token]"),
    };
  } catch (error) {
    const failures = [error];
    try {
      await close();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await writeFile(
        join(evidence, "startup-failure.json"),
        JSON.stringify({ passed: false, failures: failures.map(String) }, null, 2),
        { mode: 0o600 },
      );
    } catch (reportError) {
      failures.push(reportError);
    }
    throw new AggregateError(failures, `Owned Web Host startup failed; evidence: ${evidence}`, {
      cause: error,
    });
  }
}
