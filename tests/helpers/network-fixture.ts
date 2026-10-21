import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const guards: symbol[] = [];
/**
 * Test instrumentation for global fetch, Node http(s) request/get and Socket.connect.
 * Not an OS/network sandbox: Bun.fetch/connect, WebSocket/http2 and pre-captured
 * function references are outside this helper. Install before the first producer
 * evaluation; a later import may use the module cache. Current probes inject their
 * transport or resolve global fetch at call time. Nested guards restore only LIFO.
 */
export function installFixtureNetworkGuard(transport?: typeof fetch) {
  const origins = new Set<string>();
  const id = Symbol("fixture guard");
  guards.push(id);
  let restored = false;
  const descriptors: { target: any; key: string; descriptor?: PropertyDescriptor }[] = [];
  const replace = (target: any, key: string, value: unknown) => {
    descriptors.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
    target[key] = value;
  };
  const assertOrigin = (url: string | URL) => {
    if (!origins.has(new URL(url).origin)) throw new Error("Fixture denied a non-fixture origin");
  };
  const originalFetch = transport ?? globalThis.fetch;
  replace(globalThis, "fetch", (input: any, init?: any) => {
    assertOrigin(typeof input === "string" || input instanceof URL ? input : input.url);
    if (init?.dispatcher) throw new Error("Fixture denied a custom fetch transport");
    const redirect = init?.redirect ?? (typeof input === "object" ? input.redirect : undefined);
    if (redirect !== "error") throw new Error("Fixture requires caller redirect:error");
    return originalFetch(input, init);
  });
  for (const [module, protocol] of [
    [http, "http:"],
    [https, "https:"],
  ] as const) {
    for (const method of ["request", "get"] as const) {
      const original = module[method];
      replace(module, method, function (this: unknown, input: any, ...args: any[]) {
        const url = typeof input === "string" || input instanceof URL ? new URL(input) : undefined;
        const options = url ? (typeof args[0] === "object" ? args[0] : {}) : input;
        if (options?.socketPath || options?.createConnection || options?.lookup || options?.agent)
          throw new Error("Fixture denied a custom HTTP transport");
        assertOrigin(
          `${options?.protocol ?? url?.protocol ?? protocol}//${options?.hostname ?? options?.host ?? url?.hostname ?? "localhost"}:${options?.port ?? url?.port ?? 80}`,
        );
        return (original as any).call(this, input, ...args);
      });
    }
  }
  const originalConnect = net.Socket.prototype.connect;
  replace(net.Socket.prototype, "connect", function (this: net.Socket, ...args: any[]) {
    const first = Array.isArray(args[0]) ? args[0] : args;
    const options =
      typeof first[0] === "object"
        ? first[0]
        : { port: first[0], host: typeof first[1] === "string" ? first[1] : "localhost" };
    if (!options?.port || options?.path || options?.lookup)
      throw new Error("Fixture denied a non-fixture socket");
    assertOrigin(`http://${options.host ?? options.hostname ?? "localhost"}:${options.port}`);
    return (originalConnect as any).apply(this, args);
  });
  syncBuiltinESMExports();
  return {
    allowOrigin(value: string) {
      if (restored) throw new Error("Fixture guard is closed");
      const url = new URL(value);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
        throw new Error("Fixture requires an exact loopback origin");
      origins.add(url.origin);
    },
    restore() {
      if (restored) return;
      if (guards.at(-1) !== id)
        throw new Error("Fixture guards must restore in reverse installation order");
      guards.pop();
      restored = true;
      for (const { target, key, descriptor } of [...descriptors].reverse()) {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
      }
      syncBuiltinESMExports();
    },
  };
}
