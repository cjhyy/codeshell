import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RemoteHostManager, resolveLanHost } from "./remote-host-manager.js";
import { TrustedDeviceStore } from "./trusted-device-store.js";
import { AccessPasscode } from "./access-passcode.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A stand-in built mobile app (out/mobile) for the static server to serve. */
const MOBILE_HTML =
  '<!doctype html><html><head><title>CodeShell Remote</title></head><body><div id="app"></div></body></html>';
function mobileFixture(base: string): string {
  const root = join(base, "mobile-app");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), MOBILE_HTML);
  writeFileSync(join(root, "assets", "index-ABC123.css"), ".x{}");
  return root;
}

describe("RemoteHostManager", () => {
  test("starts, serves mobile HTML, and stops", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
      mobileRootDir: mobileFixture(dir),
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    expect(started.url).toStartWith("http://127.0.0.1:");
    const res = await fetch(`${started.url}/mobile`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Serves the built mobile app's index.html (React SPA, not inline string).
    expect(html).toContain("<title>CodeShell Remote</title>");
    expect(html).toContain('id="app"');
    await host.stop();
  });

  test("serves /mobile/assets/* (vite base '/mobile/'); root /assets/* 404s", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
      mobileRootDir: mobileFixture(dir),
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    // With vite base "/mobile/", the built index.html references
    // /mobile/assets/x — under the routed prefix, so it's served.
    const css = await fetch(`${started.url}/mobile/assets/index-ABC123.css`);
    expect(css.status).toBe(200);
    // ROOT-level /assets/* is NOT part of the route family → 404 (no shim).
    const rootAsset = await fetch(`${started.url}/assets/index-ABC123.css`);
    expect(rootAsset.status).toBe(404);
    // Traversal out of the root is blocked.
    const escape = await fetch(`${started.url}/mobile/assets/../../devices.json`);
    expect(escape.status).not.toBe(200);
    // A sibling that merely shares the /mobile prefix is not the route family.
    const sibling = await fetch(`${started.url}/mobilexyz`);
    expect(sibling.status).toBe(404);
    await host.stop();
  });

  test("bare /mobile redirects to /mobile/ (preserving query)", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
      mobileRootDir: mobileFixture(dir),
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    const res = await fetch(`${started.url}/mobile?pairing=tok`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/mobile/?pairing=tok");
    await host.stop();
  });

  test("creates pairing URL", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    const pairing = host.createPairingUrl();
    expect(pairing.url).toContain(`${started.url}/mobile?pairing=`);
    await host.stop();
  });

  test("pairs and authenticates a device over client events", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const seen: unknown[] = [];
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: (event) => seen.push(event),
    });
    await host.start({ host: "127.0.0.1", port: 0 });
    const pairing = host.createPairingUrl();

    const paired = host.handleClientEvent({
      type: "pair.complete",
      token: pairing.token,
      name: "iPhone",
      secretHash: "h1",
    });
    expect(paired?.type).toBe("pair.ok");
    const device = paired?.type === "pair.ok" ? paired.device : undefined;
    expect(device?.name).toBe("iPhone");

    const authed = host.handleClientEvent({
      type: "auth.device",
      deviceId: device!.id,
      secretHash: "h1",
    });
    expect(authed?.type).toBe("auth.ok");
    await host.stop();
  });

  test("rejects auth for revoked device", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    const host = new RemoteHostManager({ devices: store, onClientEvent: () => {} });
    await host.start({ host: "127.0.0.1", port: 0 });
    const pairing = host.createPairingUrl();
    const paired = host.handleClientEvent({
      type: "pair.complete",
      token: pairing.token,
      name: "iPhone",
      secretHash: "h1",
    });
    const device = paired?.type === "pair.ok" ? paired.device : undefined;
    store.revoke(device!.id);
    const authed = host.handleClientEvent({
      type: "auth.device",
      deviceId: device!.id,
      secretHash: "h1",
    });
    expect(authed?.type).toBe("auth.failed");
    await host.stop();
  });

  test("tracks online devices by socket refcount and emits online-change", () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const events: string[][] = [];
    const offline: string[] = [];
    host.on("online-change", (ids: string[]) => events.push([...ids].sort()));
    host.on("device-offline", (id: string) => offline.push(id));

    expect(host.onlineDeviceIds()).toEqual([]);
    host.markOnline("dev1");
    expect(host.onlineDeviceIds()).toContain("dev1");
    // a second socket for the same device does not double-count nor re-emit a
    // membership change
    host.markOnline("dev1");
    host.markOnline("dev2");
    host.markOffline("dev1"); // still one socket left → dev1 stays online
    expect(host.onlineDeviceIds().sort()).toEqual(["dev1", "dev2"]);
    expect(offline).toEqual([]);
    host.markOffline("dev1"); // last socket gone → dev1 offline
    expect(host.onlineDeviceIds()).toEqual(["dev2"]);
    expect(offline).toEqual(["dev1"]);

    // dev1 appears then disappears; dev2 appears → at least these transitions
    expect(events.some((e) => e.includes("dev1"))).toBe(true);
    expect(events[events.length - 1]).toEqual(["dev2"]);
  });

  test("sendToDevice targets only the named device's sockets (multi-device isolation)", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    // Pre-trust two devices.
    const a = store.addDevice({ name: "A", secretHash: "sa" });
    const b = store.addDevice({ name: "B", secretHash: "sb" });
    const host = new RemoteHostManager({ devices: store, onClientEvent: () => {} });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    const wsUrl = started.url.replace(/^http/, "ws") + "/ws";

    // Connect two real sockets and auth each as a different device.
    const { WebSocket: WS } = await import("ws");
    function connectAs(deviceId: string, secret: string) {
      return new Promise<{ sock: import("ws").WebSocket; got: unknown[] }>((res) => {
        const sock = new WS(wsUrl);
        const got: unknown[] = [];
        sock.on("message", (raw) => {
          const m = JSON.parse(String(raw));
          if (m.type === "auth.ok") res({ sock, got });
          else got.push(m);
        });
        sock.on("open", () =>
          sock.send(JSON.stringify({ type: "auth.device", deviceId, secretHash: secret })),
        );
      });
    }
    const ca = await connectAs(a.id, "sa");
    const cb = await connectAs(b.id, "sb");

    // Send a device-specific event to A only.
    host.sendToDevice(a.id, { type: "chat.accepted", sessionId: "sess-A" });
    await new Promise((r) => setTimeout(r, 50));

    const aGotit = ca.got.some(
      (m) => (m as { type?: string; sessionId?: string }).sessionId === "sess-A",
    );
    const bGotit = cb.got.some(
      (m) => (m as { type?: string; sessionId?: string }).sessionId === "sess-A",
    );
    expect(aGotit).toBe(true);
    expect(bGotit).toBe(false); // B must NOT see A's reply

    ca.sock.close();
    cb.sock.close();
    await host.stop();
  });

  test("resolveLanHost never returns loopback/link-local/VPN ranges", () => {
    const ip = resolveLanHost();
    // CI/sandbox may have no LAN interface → undefined is allowed.
    if (ip !== undefined) {
      expect(ip.startsWith("127.")).toBe(false);
      expect(ip.startsWith("169.254.")).toBe(false);
      expect(ip.startsWith("198.18.")).toBe(false);
    }
  });

  test("host 'lan' binds a non-loopback address when a LAN interface exists", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
      mobileRootDir: mobileFixture(dir),
    });
    const started = await host.start({ host: "lan", port: 0 });
    // Either a real LAN IP, or the documented localhost fallback if none found.
    expect(started.url).toMatch(/^http:\/\/(\d{1,3}\.){3}\d{1,3}:\d+$/);
    const res = await fetch(`${started.url}/mobile`);
    expect(res.status).toBe(200);
    await host.stop();
  });

  // ── Tunnel mode ───────────────────────────────────────────────────────────

  test("mode 'tunnel' binds 127.0.0.1 (never a LAN address)", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const passcode = new AccessPasscode({ filePath: join(dir, "access.json") });
    passcode.set("correct");
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ mode: "tunnel", host: "lan", port: 0, passcode });
    expect(started.host).toBe("127.0.0.1");
    expect(started.url).toStartWith("http://127.0.0.1:");
    await host.stop();
  });

  test("tunnel mode: /mobile without a credential is gated (401)", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const passcode = new AccessPasscode({ filePath: join(dir, "access.json") });
    passcode.set("correct");
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ mode: "tunnel", host: "lan", port: 0, passcode });
    const res = await fetch(`${started.url}/mobile`);
    expect(res.status).toBe(401);
    await host.stop();
  });

  test("tunnel mode: correct passcode query passes the gate and serves HTML", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const passcode = new AccessPasscode({ filePath: join(dir, "access.json") });
    passcode.set("correct");
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
      mobileRootDir: mobileFixture(dir),
    });
    const started = await host.start({ mode: "tunnel", host: "lan", port: 0, passcode });
    const res = await fetch(`${started.url}/mobile?passcode=correct`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="app"');
    await host.stop();
  });

  test("tunnel mode: WS upgrade without a credential is rejected", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const passcode = new AccessPasscode({ filePath: join(dir, "access.json") });
    passcode.set("correct");
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ mode: "tunnel", host: "lan", port: 0, passcode });
    const wsUrl = `${started.url.replace(/^http/, "ws")}/ws`;
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.close();
        resolve(0); // unexpectedly opened
      };
      ws.onerror = () => resolve(-1);
      ws.onclose = (e) => resolve(e.code);
    });
    expect(code).not.toBe(0);
    await host.stop();
  });

  test("setPublicBaseUrl makes createPairingUrl use the tunnel domain", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const passcode = new AccessPasscode({ filePath: join(dir, "access.json") });
    passcode.set("correct");
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    await host.start({ mode: "tunnel", host: "lan", port: 0, passcode });
    host.setPublicBaseUrl("https://foo-bar.trycloudflare.com");
    const pairing = host.createPairingUrl();
    expect(pairing.url).toStartWith("https://foo-bar.trycloudflare.com/mobile?pairing=");
    await host.stop();
  });

  test("lan mode (no passcode) serves /mobile with no gate (regression)", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
      mobileRootDir: mobileFixture(dir),
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    const res = await fetch(`${started.url}/mobile`);
    expect(res.status).toBe(200);
    await host.stop();
  });

  test("static serve blocks path traversal out of out/mobile", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
      mobileRootDir: mobileFixture(dir),
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    const res = await fetch(`${started.url}/mobile/../../devices.json`);
    // The path is normalized by fetch/url, but the server's resolveSafe also
    // rejects any escape → never leak a sibling file.
    expect(res.status).not.toBe(200);
    await host.stop();
  });
});
