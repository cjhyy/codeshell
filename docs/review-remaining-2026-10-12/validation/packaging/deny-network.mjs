import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
const allowed = new Set();
let denied = 0, accepted = 0;
const fail = () => { denied++; throw new Error("remaining review network guard denied request"); };
const checkUrl = (input) => { const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); if (!allowed.has(url.origin)) fail(); accepted++; };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => { checkUrl(input); return originalFetch(input, init); };
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
 const actual = Array.isArray(args[0]) ? args[0] : args;
 const opts = typeof actual[0] === "object" ? actual[0] : { port: actual[0], host: typeof actual[1] === "string" ? actual[1] : "localhost" };
 if (!opts || !allowed.has(`http://${opts.host ?? "localhost"}:${opts.port}`)) fail();
 accepted++; return originalConnect.apply(this, args);
};
for (const api of [http, https]) for (const method of ["request", "get"]) {
 const original=api[method]; api[method]=function(input, ...args) { if (typeof input === "string" || input instanceof URL) checkUrl(input); else { const opts=input ?? {}; checkUrl(`${opts.protocol ?? (api === https ? "https:" : "http:")}//${opts.hostname ?? opts.host ?? "localhost"}:${opts.port ?? (api === https ? 443 : 80)}`); } return original.call(this,input,...args); };
}
tls.connect = fail; tls.TLSSocket.prototype.connect = fail; dgram.createSocket = fail;

process.on("exit", () => console.log(JSON.stringify({ reviewNetworkGuard: true, accepted, denied, origins: [...allowed] })));
