import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInSubprocess } from "../../../../tests/helpers/bundle-in-subprocess.ts";

test("native tunnel pipes keep draining after URL capture and throughout edge recovery", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "tunnel-pipes-native-"));
  try {
    bundleInSubprocess(
      [
        fileURLToPath(new URL("tunnel-manager.ts", import.meta.url)),
        fileURLToPath(new URL("../../../../tests/helpers/network-fixture.ts", import.meta.url)),
      ],
      temporary,
      { naming: "[name].js" },
    );
    await writeFile(join(temporary, "package.json"), '{"type":"module"}');
    await writeFile(
      join(temporary, "fake-cloudflared.mjs"),
      String.raw`
import http from "node:http";
import { once } from "node:events";
let ready = false;
const server = http.createServer((_request, response) => {
  response.writeHead(ready ? 200 : 503, {"content-type":"application/json"});
  response.end(JSON.stringify({readyConnections:ready ? 1 : 0}));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
process.send({port:server.address().port});
const flood = async () => {
  const chunk = Buffer.alloc(64 * 1024, "x");
  for (const stream of [process.stdout, process.stderr]) {
    for (let index = 0; index < 128; index++) {
      if (!stream.write(chunk)) await once(stream, "drain");
    }
  }
  ready = true;
};
process.on("message", async (message) => {
  if (message === "disconnect") ready = false;
  else if (message === "recover") await flood();
});
process.on("disconnect", () => process.exit(0));
process.stderr.write("https://owned-log-flood.trycloudflare.com\n");
await flood();
`,
    );
    await writeFile(
      join(temporary, "fixture.mjs"),
      String.raw`
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { installFixtureNetworkGuard } from "./network-fixture.js";
const guard = installFixtureNetworkGuard();
const { TunnelManager } = await import("./tunnel-manager.js");
let child, origin;
const statuses = [];
const manager = new TunnelManager({
  binaryPath:() => process.execPath,
  spawn:command => {
    child = spawn(command, [fileURLToPath(new URL("./fake-cloudflared.mjs", import.meta.url))], {
      stdio:["ignore", "pipe", "pipe", "ipc"],
    });
    child.on("message", message => {
      origin = "http://127.0.0.1:" + message.port;
      guard.allowOrigin(origin);
    });
    return child;
  },
  checkReady:async () => {
    if (!origin) return false;
    const response = await fetch(origin + "/ready", {signal:AbortSignal.timeout(1000), redirect:"error"});
    return response.ok && (await response.json()).readyConnections > 0;
  },
  timeoutMs:3000, readyTimeoutMs:4000, readyIntervalMs:10,
  healthCheckIntervalMs:10, healthFailureThreshold:2,
  killGraceMs:100, killHardTimeoutMs:1000,
});
manager.on("status", status => statuses.push(status));
const waitFor = async predicate => {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "tunnel failed to recover after draining logs");
    await delay(10);
  }
};
try {
  const started = await manager.start(12345);
  assert.equal(started.url, "https://owned-log-flood.trycloudflare.com");
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdout.readableFlowing, true);
  assert.equal(child.stderr.readableFlowing, true);
  child.send("disconnect");
  await waitFor(() => statuses.includes("disconnected"));
  assert.equal(manager.isRunning(), true);
  child.send("recover");
  await waitFor(() => statuses.filter(status => status === "connected").length === 2);
  assert.equal(manager.publicUrl(), started.url);
  assert.equal(manager.isConnected(), true);
  console.log(JSON.stringify({ok:true,drainedMiB:32,recoveredSameChild:true}));
} finally {
  await manager.stop();
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
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ok: true, drainedMiB: 32, recoveredSameChild: true });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);
