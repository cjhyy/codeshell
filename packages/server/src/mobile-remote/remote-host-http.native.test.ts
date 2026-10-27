import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The Node HTTP parser accepts targets that WHATWG URL parsing rejects.
// Exercise raw requests through the production Host, before authentication.
test("native remote Host returns 400 for malformed targets and remains healthy", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "remote-http-native-"));
  try {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    await symlink(join(packageRoot, "node_modules"), join(temporary, "node_modules"));
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL("remote-host-manager.ts", import.meta.url)),
        fileURLToPath(new URL("trusted-device-store.ts", import.meta.url)),
        resolve(packageRoot, "../../tests/helpers/network-fixture.ts"),
      ],
      naming: "[name].js",
      outdir: temporary,
      target: "node",
      external: ["ws"],
    });
    expect(build.success).toBe(true);
    await writeFile(join(temporary, "package.json"), '{"type":"module"}');
    await writeFile(
      join(temporary, "fixture.mjs"),
      String.raw`
import assert from "node:assert/strict";
import { connect } from "node:net";
import { installFixtureNetworkGuard } from "./network-fixture.js";
const guard = installFixtureNetworkGuard();
const { RemoteHostManager } = await import("./remote-host-manager.js");
const { TrustedDeviceStore } = await import("./trusted-device-store.js");
let dispatched = 0;
const host = new RemoteHostManager({
  devices: new TrustedDeviceStore(new URL("devices.json", import.meta.url).pathname),
  onClientEvent: () => { dispatched++; },
});
host.on("host-error", error => { throw error; });
const started = await host.start({host:"127.0.0.1",port:0});
guard.allowOrigin(started.url);
try {
  for (const target of ["//[", "http://["]) {
    const response = await new Promise((resolve, reject) => {
      const socket = connect({host:"127.0.0.1",port:started.port});
      let text = "";
      socket.on("error", reject);
      socket.on("data", chunk => { text += chunk; });
      socket.on("end", () => resolve(text));
      socket.on("connect", () => socket.write(
        "GET " + target + " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      ));
    });
    assert.match(response, /^HTTP\/1\.1 400 /);
  }
  assert.equal((await fetch(started.url + "/health", {redirect:"error"})).status, 200);
  assert.equal(dispatched, 0);
  console.log(JSON.stringify({ok:true, rejected:2}));
} finally {
  await host.stop();
  guard.restore();
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
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ok: true, rejected: 2 });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 15_000);
