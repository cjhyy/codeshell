import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bun's WebSocket compatibility layer does not enforce ws maxPayload in the
// same way as the Node host. Exercise the actual deployment transport.
test("native remote host isolates oversized WebSocket frames without exiting", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "remote-host-native-"));
  try {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    await symlink(join(packageRoot, "node_modules"), join(temporary, "node_modules"));
    const built = await Bun.build({
      entrypoints: ["remote-host-manager.ts", "trusted-device-store.ts"].map((file) =>
        fileURLToPath(new URL(file, import.meta.url)),
      ),
      outdir: temporary,
      target: "node",
      external: ["ws"],
    });
    expect(built.success).toBe(true);
    await writeFile(join(temporary, "package.json"), '{"type":"module"}');
    await writeFile(
      join(temporary, "fixture.mjs"),
      `
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { RemoteHostManager } from "./remote-host-manager.js";
import { TrustedDeviceStore } from "./trusted-device-store.js";
const errors = [];
let dispatched = 0;
const host = new RemoteHostManager({
  devices: new TrustedDeviceStore(new URL("devices.json", import.meta.url).pathname),
  onClientEvent: () => { dispatched += 1; },
});
host.on("host-error", (error) => errors.push(error));
const started = await host.start({ host: "127.0.0.1", port: 0 });
const socket = new WebSocket(started.url.replace("http:", "ws:") + "/ws");
socket.on("error", () => {});
try {
  await once(socket, "open");
  const closed = once(socket, "close");
  socket.send("x".repeat(1024 * 1024 + 1));
  await closed;
  assert.equal(errors.length, 1);
  assert.equal(dispatched, 0);
  assert.equal((await fetch(started.url + "/health")).status, 200);
  console.log(JSON.stringify({ ok: true, oversizedConnectionClosed: true }));
} finally {
  socket.terminate();
  await host.stop();
}
`,
    );
    const child = Bun.spawn(["node", join(temporary, "fixture.mjs")], {
      cwd: temporary,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ok: true, oversizedConnectionClosed: true });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 15_000);
