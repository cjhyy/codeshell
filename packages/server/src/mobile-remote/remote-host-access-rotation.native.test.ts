import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInSubprocess } from "../../../../tests/helpers/bundle-in-subprocess.ts";

test("native public sockets lose both directions after passcode rotation while LAN stays connected", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "remote-passcode-native-"));
  try {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    await symlink(join(packageRoot, "node_modules"), join(temporary, "node_modules"));
    bundleInSubprocess(
      [
        ...["remote-host-manager", "trusted-device-store", "access-passcode"].map((name) =>
          fileURLToPath(new URL(`${name}.ts`, import.meta.url)),
        ),
        resolve(packageRoot, "../../tests/helpers/network-fixture.ts"),
      ],
      temporary,
      { naming: "[name].js", external: ["ws", "@cjhyy/code-shell-core/internal"] },
    );
    await writeFile(join(temporary, "package.json"), '{"type":"module"}');
    await writeFile(
      join(temporary, "fixture.mjs"),
      String.raw`
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { installFixtureNetworkGuard } from "./network-fixture.js";
const guard = installFixtureNetworkGuard();
const guardedRequest = http.request;
// ws installs its default net connector explicitly. Use Node's identical
// default connector so the exact-origin fixture guard can check the request.
http.request = (options, ...args) => {
  if (options?.headers?.Upgrade === "websocket") {
    const {createConnection: _connector, ...direct} = options;
    return guardedRequest(direct, ...args);
  }
  return guardedRequest(options, ...args);
};
const { RemoteHostManager } = await import("./remote-host-manager.js");
const { TrustedDeviceStore } = await import("./trusted-device-store.js");
const { AccessPasscode } = await import("./access-passcode.js");
const root = new URL(".", import.meta.url).pathname;
try {
  for (const mode of ["tunnel", "relay", "lan"]) {
    const passcode = new AccessPasscode({ filePath: join(root, mode + "-access.json") });
    passcode.set("original-passcode");
    const devices = new TrustedDeviceStore(join(root, mode + "-devices.json"));
    const device = devices.addDevice({ name: "Phone", secretHash: "fixture-paired-secret" });
    const dispatched = [];
    const offline = [];
    const host = new RemoteHostManager({
      devices,
      onClientEvent: (event, socket) => {
        dispatched.push(event);
        socket.send(JSON.stringify({type:"fixture.echo", request:event.type, viewerId:event.viewerId}));
      },
    });
    host.on("viewer-offline", identity => offline.push(identity));
    const started = await host.start({mode, host:"127.0.0.1", port:0, passcode});
    guard.allowOrigin(started.url);
    const origin = mode === "relay" ? "https://remote.example.test" : started.url;
    if (mode === "relay") host.setPublicBaseUrl(origin);
    const sockets = [];
    const connect = async (password) => {
      const socket = new WebSocket(started.url.replace("http:", "ws:") + "/ws", {
        headers: {Host:new URL(origin).host, Origin:origin, "X-Access-Passcode":password},
      });
      socket.on("error", () => {});
      socket.messages = [];
      socket.on("message", raw => socket.messages.push(JSON.parse(String(raw))));
      socket.on("close", code => { socket.closeCode = code; });
      sockets.push(socket);
      await once(socket, "open", {signal:AbortSignal.timeout(2000)});
      const reply = once(socket, "message", {signal:AbortSignal.timeout(2000)});
      socket.send(JSON.stringify({type:"auth.device", deviceId:device.id, secretHash:"fixture-paired-secret"}));
      assert.equal(JSON.parse(String((await reply)[0])).type, "auth.ok");
      return socket;
    };
    const closed = socket => socket.readyState === WebSocket.CLOSED
      ? Promise.resolve()
      : once(socket, "close", {signal:AbortSignal.timeout(2500)});
    try {
      const chat = await connect("original-passcode");
      const approval = await connect("original-passcode");
      const output = await connect("original-passcode");
      passcode.set("rotated-passcode");
      chat.send(JSON.stringify({type:"chat.send", text:"must not run after rotation"}));
      approval.send(JSON.stringify({type:"approval.respond", approvalId:"pending", decision:"approve"}));
      await delay(60);
      if (mode === "lan") {
        assert.deepEqual(dispatched.map(event => event.type), ["chat.send", "approval.respond"]);
        host.broadcastRaw(JSON.stringify({type:"fixture.output"}));
        await delay(30);
        assert.ok(output.messages.some(event => event.type === "fixture.output"));
        assert.equal(offline.length, 0);
        continue;
      }
      assert.deepEqual(dispatched, [], mode + " must reject old socket chat and approval");
      host.broadcastRaw(JSON.stringify({type:"fixture.output"}));
      await Promise.all([chat, approval, output].map(closed));
      assert.ok(sockets.every(socket => !socket.messages.some(event => event.type === "fixture.output")));
      assert.ok(sockets.every(socket => socket.closeCode === 4407));
      assert.equal(offline.length, 3);
      assert.deepEqual(host.onlineDeviceIds(), []);

      const idle = await connect("rotated-passcode");
      passcode.set("final-passcode");
      // No inbound/outbound traffic: the bounded sweep still retires the tab.
      await closed(idle);
      assert.equal(idle.closeCode, 4407);
      assert.equal(offline.length, 4);
      const fresh = await connect("final-passcode");
      const reply = once(fresh, "message", {signal:AbortSignal.timeout(2000)});
      fresh.send(JSON.stringify({type:"session.list"}));
      const value = JSON.parse(String((await reply)[0]));
      assert.equal(value.request, "session.list");
      assert.equal(host.hasAuthenticatedViewer(value.viewerId, device.id), true);
      assert.deepEqual(host.onlineDeviceIds(), [device.id]);
    } finally {
      for (const socket of sockets) socket.terminate();
      await host.stop();
    }
  }
  console.log(JSON.stringify({ok:true,tunnel:true,relay:true,lanUnchanged:true}));
} finally {
  guard.restore();
}
`,
    );
    const child = Bun.spawn(["node", join(temporary, "fixture.mjs")], {
      cwd: temporary,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        tunnel: true,
        relay: true,
        lanUnchanged: true,
      });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 25_000);
