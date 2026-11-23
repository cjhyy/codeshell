// Run as an Electron main process, with the repository's isolated test HOME.
import assert from "node:assert/strict";
import children from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app } from "electron";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";
import { startMockProviderServer } from "../mock-provider-server.mjs";

const root = process.env.CODE_SHELL_TEST_HOME;
assert(
  root && root === process.env.CODE_SHELL_HOME,
  "Expected a fresh, isolated profile",
);
const desktopRequire = createRequire(
  new URL("../../package.json", import.meta.url),
);
const worker = desktopRequire.resolve(
  "@cjhyy/code-shell-core/bin/agent-server-stdio",
);
const proxy = fileURLToPath(
  new URL("../../out/main/cua-activity-proxy.mjs", import.meta.url),
);
const workspace = join(root, "workspace");
const childReceipts = join(root, "runtime.jsonl");
const live = new Set();

// Exchange one framed request, then require an orderly stdin-EOF shutdown.
async function initialize(entry, args, params) {
  const proc = children.spawn(process.execPath, [entry, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODE_SHELL_CREDENTIAL_ACCESS: "local",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const closed = once(proc, "close");
  const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
  try {
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params }) +
        "\n",
    );
    const lines = createInterface({ input: proc.stdout });
    let result;
    for await (const line of lines) {
      const reply = JSON.parse(line);
      if (reply.id !== 1) continue;
      assert.ok(reply.result, JSON.stringify(reply.error));
      result = reply.result;
      proc.stdin.end();
    }
    assert.deepEqual(await closed, [0, null], basename(entry));
    assert.ok(result, `No initialize response from ${entry}`);
    return result;
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  }
}

async function run() {
  assert.equal(
    process.versions.electron,
    desktopRequire("electron/package.json").version,
  );
  assert.equal(process.versions.node.split(".")[0], "24");
  await app.whenReady();
  const model = await startMockProviderServer();
  installLocalNetworkGuard(model.origin);
  // Install the exact-origin fixture before any Core imports in *each* real child.
  // Electron can ignore NODE_OPTIONS, so pass the preload on the child's argv.
  const preload = join(root, "runtime-guard.mjs");
  const guard = new URL(
    "../../../../scripts/runtime-cost-smoke-isolation.mjs",
    import.meta.url,
  );
  await writeFile(
    preload,
    `
import { appendFileSync } from "node:fs";
import { installLocalNetworkGuard } from ${JSON.stringify(guard.href)};
installLocalNetworkGuard(${JSON.stringify(model.origin)});
appendFileSync(${JSON.stringify(childReceipts)}, JSON.stringify({
  entry: process.argv[1], pid: process.pid, electron: process.versions.electron,
  node: process.versions.node, mode: process.env.ELECTRON_RUN_AS_NODE,
}) + "\\n", {mode: 0o600});
`,
  );
  const originalSpawn = children.spawn;
  children.spawn = function (command, args, options) {
    if (args?.[0] !== worker && args?.[0] !== proxy)
      return originalSpawn.call(this, command, args, options);
    assert.equal(command, process.execPath);
    const proc = originalSpawn.call(
      this,
      command,
      ["--import", pathToFileURL(preload).href, ...args],
      options,
    );
    live.add(proc);
    proc.once("close", () => live.delete(proc));
    return proc;
  };
  syncBuiltinESMExports();
  let api;
  try {
    const sample = join(root, "fixture-panel");
    await mkdir(join(workspace, ".code-shell"), { recursive: true });
    await mkdir(join(sample, ".codeshell-panel"), { recursive: true });
    await mkdir(join(sample, "app"));
    await writeFile(
      join(sample, "app/index.html"),
      "<!doctype html><title>Runtime test</title>",
    );
    await writeFile(
      join(sample, ".codeshell-panel/panel.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "runtime-test",
        version: "1.0.0",
        title: { default: "Runtime test" },
        entry: "app/index.html",
        placement: "right-dock",
        icon: "panel",
        singleton: true,
        permissions: ["context.workspace", "agent.task"],
      }),
    );
    await writeFile(
      join(workspace, ".code-shell/settings.local.json"),
      JSON.stringify({
        credentials: [
          {
            id: "fixture",
            catalogId: "openai",
            apiKey: "fixture",
            baseUrl: model.baseUrl,
          },
        ],
        modelConnections: [
          {
            id: "fixture",
            catalogId: "openai",
            tag: "text",
            model: "gpt-4o-mini",
            credentialId: "fixture",
          },
        ],
        defaults: { text: "fixture" },
        autoUpdates: false,
      }),
    );
    await writeFile(
      join(workspace, ".code-shell/settings.json"),
      JSON.stringify({ panelAppBindings: ["runtime-test"] }),
    );
    const { protocolVersion, contracts } = await initialize(worker, [], {});
    assert.ok(protocolVersion);
    assert.equal(protocolVersion, contracts.agentProtocol.preferred);

    const driver = fileURLToPath(
      new URL("./electron-runtime-driver.mjs", import.meta.url),
    );
    const mcp = await initialize(
      proxy,
      ["--driver", driver, "--socket", join(root, "cua.sock")],
      {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "smoke", version: "1" },
        capabilities: {},
      },
    );
    assert.equal(mcp.serverInfo.name, "fixture-driver");

    const { installReviewedLocalPanelApp, previewLocalPanelApp } =
      await import("@cjhyy/code-shell-core");
    const source = { kind: "dir", path: sample };
    const review = await previewLocalPanelApp(source);
    await installReviewedLocalPanelApp(
      source,
      review.reviewToken,
      new Date().toISOString(),
    );
    const { TrustedDeviceStore } =
      await import("@cjhyy/code-shell-server/mobile-remote");
    const { createDesktopWebService } = await import(
      pathToFileURL(process.argv.at(-1)).href
    );
    const devices = new TrustedDeviceStore(join(root, "devices.json"));
    const secretHash = "runtime-smoke-secret";
    const device = devices.addDevice({ name: "Runtime test", secretHash });
    api = createDesktopWebService({
      devices,
      getBridge: () => null,
      onSessionsChanged() {},
      resolveWorkspace: async (cwd) =>
        !cwd || cwd === workspace ? workspace : undefined,
    });
    api.start();
    // Pairing, the Panel route and the mock provider all use the single approved origin.
    const [provider] = model.server.listeners("request");
    model.server.removeListener("request", provider);
    model.server.on("request", (req, res) => {
      if (!req.url.startsWith("/api/")) return provider(req, res);
      void api
        .handle(req, res, { baseUrl: model.origin })
        .then((handled) => {
          if (!handled) res.writeHead(404).end();
        })
        .catch((error) => res.destroy(error));
    });
    let cookie;
    async function request(path, body) {
      const response = await fetch(model.origin + "/api/v1/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: model.origin,
          "Content-Type": "application/json",
          "X-CodeShell-Workspace": encodeURIComponent(workspace),
          ...(cookie && { Cookie: cookie }),
        },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      cookie ??= response.headers.get("set-cookie")?.split(";", 1)[0];
      return response.json();
    }
    await request("desktop/session", { deviceId: device.id, secretHash });
    const { panels } = await request("panels");
    const panel = panels.find((p) => p.id === "runtime-test");
    assert.ok(panel);
    const { instanceId } = await request("panels/runtime/prepare", {
      appId: panel.id,
      revision: panel.revision,
    });
    const call = (method, params) =>
      request(`panels/runtime/${instanceId}/call`, { method, params });
    const prompt = "Electron Panel worker smoke";
    const task = await call("agent.task.start", {
      label: "Runtime test",
      prompt,
      maxTurns: 3,
      toolNames: [],
    });
    const deadline = Date.now() + 20_000;
    let view = task;
    while (
      ["queued", "running"].includes(view.status) &&
      Date.now() < deadline
    ) {
      await delay(100);
      view = await call("agent.task.get", { id: task.id });
    }
    assert.equal(view.status, "completed", JSON.stringify(view));
    assert.match(view.result.text, /smoke response completed/i);
    assert.ok(
      model.requests.some(({ body }) =>
        JSON.stringify(body.messages).includes(prompt),
      ),
    );
    const receipts = (await readFile(childReceipts, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      receipts.map((r) => r.entry),
      [worker, proxy, worker],
    );
    assert.equal(new Set(receipts.map((r) => r.pid)).size, 3);
    for (const receipt of receipts) {
      assert.equal(receipt.mode, "1");
      assert.equal(receipt.electron, process.versions.electron);
      assert.equal(receipt.node, process.versions.node);
    }
    console.log(
      "Electron worker, CUA proxy and paired Desktop Web Panel worker:",
      receipts,
    );
    const exitDeadline = Date.now() + 3000;
    while (live.size && Date.now() < exitDeadline) await delay(50);
    assert.equal(
      live.size,
      0,
      "Worker did not exit after the Panel task completed",
    );
  } finally {
    for (const proc of live) proc.kill("SIGKILL");
    await api?.close();
    model.server.closeAllConnections();
    await model.close();
  }
}

run().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
