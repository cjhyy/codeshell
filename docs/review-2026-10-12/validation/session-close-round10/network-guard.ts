import { expect, afterAll } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

expect(realpathSync(process.env.HOME!)).toContain("codeshell-bun-completion-");
const attempts: string[] = [];
for (const [object, key] of [
  [globalThis, "fetch"], [http, "request"], [http, "get"],
  [https, "request"], [https, "get"], [net, "connect"],
  [net, "createConnection"], [net.Socket.prototype, "connect"],
  [tls, "connect"], [tls.TLSSocket.prototype, "connect"],
] as const) {
  Reflect.set(object, key, () => {
    attempts.push(String(key));
    throw new Error("review close controls outbound denied");
  });
}
syncBuiltinESMExports();
expect(() => fetch("https://outside.invalid/")).toThrow("outbound denied");
expect(() => http.request("http://127.0.0.1:9/")).toThrow("outbound denied");
expect(() => https.request("https://outside.invalid/")).toThrow("outbound denied");
expect(() => net.connect(9, "127.0.0.1")).toThrow("outbound denied");
expect(() => tls.connect(443, "outside.invalid")).toThrow("outbound denied");
afterAll(() => expect(attempts).toHaveLength(5));
