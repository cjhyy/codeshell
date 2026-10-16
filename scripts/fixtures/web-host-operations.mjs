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
        const input = JSON.stringify(body.messages);
        assert(
          input.includes("OWNED_"),
          "Auxiliary request must contain only this fixture's conversation",
        );
        requests.push({ marker: "owned-title", body });
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
  const nonce = randomUUID();
  const receiptsPath = join(clean.HOME, "network-process-receipts.jsonl");
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
  const child = spawn(
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
  let spawnFailure;
  child.on("error", (error) => {
    spawnFailure = error;
  });
  let logs = "",
    serial = 0;
  const messages = [];
  child.on("message", (message) => messages.push(message));
  child.stdout.on("data", (part) => {
    logs = (logs + part).slice(-60_000);
  });
  child.stderr.on("data", (part) => {
    logs = (logs + part).slice(-60_000);
  });
  const control = async (action) => {
    const id = ++serial;
    child.send({ nonce, id, action });
    return (await waitFor(() => messages.find((m) => m.id === id), `Host control ${action}`, 5000))
      .result;
  };
  const close = async () => {
    for (const res of streams) res.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }, 5000);
      await exited;
      clearTimeout(timer);
    }
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
    const guards = (await readFile(receiptsPath, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter((row) => row.kind === "pre-core-network-guard");
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
      try {
        const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
          encoding: "utf8",
        }).trim();
        return state && !state.startsWith("Z");
      } catch (error) {
        if (error.status === 1) return false;
        throw error;
      }
    };
    const cleanup = [];
    for (const row of guards) {
      assert(
        row.pid === child.pid ||
          (row.ppid === child.pid &&
            row.entry === join(repository, "packages/core/dist/cli/agent-server-stdio.js")),
        "Cleanup touches only this Host and its guarded actual Worker",
      );
      let forced = false;
      if (alive(row.pid)) {
        const command = execFileSync("ps", ["-p", String(row.pid), "-o", "args="], {
          encoding: "utf8",
        });
        assert(
          command.includes(row.entry),
          "Owned PID command identity must still match before cleanup",
        );
        process.kill(row.pid, "SIGKILL");
        forced = true;
        await waitFor(() => !alive(row.pid), "owned process cleanup", 3000);
      }
      cleanup.push({ pid: row.pid, ppid: row.ppid, alive: false, forced });
    }
    await writeFile(
      join(evidence, "cleanup.json"),
      JSON.stringify({ processes: cleanup, providerClosed: !provider.listening }, null, 2),
      { mode: 0o600 },
    );
  };
  try {
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
    await close();
    throw error;
  }
}
