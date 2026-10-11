import { afterAll, expect } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";

// Guarded runner owns HOME. This guard denies enumerated JS transports;
// it is not an OS sandbox. Product-facing IPC/worker/model calls are local doubles.
expect(realpathSync(process.env.HOME!)).toContain("codeshell-bun-completion-");
const surfaces = [[globalThis, "fetch"], [http, "request"], [http, "get"],
  [https, "request"], [https, "get"], [net, "connect"], [net, "createConnection"],
  [net.Socket.prototype, "connect"], [tls, "connect"], [tls.TLSSocket.prototype, "connect"]] as const;
const attempts: string[] = [];
for (const [object, key] of surfaces) Reflect.set(object, key, () => {
  attempts.push(String(key)); throw new Error("round8 outbound denied");
});
syncBuiltinESMExports();
for (const probe of [() => fetch("https://outside.invalid/"), () => http.request("http://127.0.0.1:9/"),
  () => https.request("https://outside.invalid/"), () => net.connect(9, "127.0.0.1"),
  () => tls.connect(443, "outside.invalid")]) expect(probe).toThrow("outbound denied");
afterAll(() => {
  expect(attempts).toHaveLength(5);
  writeFileSync(new URL(`./guard-${process.pid}.json`, import.meta.url), JSON.stringify({
    pid: process.pid, guardScope: "JavaScript transports only",
    homeSha256: createHash("sha256").update(realpathSync(process.env.HOME!)).digest("hex"),
    negativeProbes: 5, unexpectedTransports: attempts.length - 5,
  }, null, 2));
});
