import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { installLocalNetworkGuard } from "../../../../../scripts/runtime-cost-smoke-isolation.mjs";

/** Own and restore the fixture guard so unrelated HTTP test files remain isolated. */
export function guardProjectScopeNetwork(afterAll: (cleanup: () => void) => unknown) {
  const marker = Symbol.for("codeshell.cost-smoke.network-guard");
  const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker);
  const surfaces = [
    [globalThis, "fetch"],
    [http, "get"],
    [http, "request"],
    [https, "get"],
    [https, "request"],
    [net, "connect"],
    [net, "createConnection"],
    [net.Socket.prototype, "connect"],
  ] as const;
  const previous = surfaces.map(([object, key]) => Object.getOwnPropertyDescriptor(object, key));
  installLocalNetworkGuard("http://127.0.0.1:9");
  const deny = () => {
    throw new Error("Panel scope fixture refused network");
  };
  for (const [object, key] of surfaces) Reflect.set(object, key, deny);
  syncBuiltinESMExports();
  const owned = surfaces.map(([object, key]) => Reflect.get(object, key));
  afterAll(() => {
    if (surfaces.some(([object, key], index) => Reflect.get(object, key) !== owned[index]))
      throw new Error("Panel scope fixture lost its network guard");
    surfaces.forEach(([object, key], index) =>
      Object.defineProperty(object, key, previous[index]!),
    );
    if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker);
    else Reflect.deleteProperty(globalThis, marker);
    syncBuiltinESMExports();
  });
  // Probe before the caller imports Core/Host. These throw synchronously without network I/O.
  let denied = 0;
  for (const probe of [
    () => fetch("https://scope.invalid/"),
    () => http.get("http://127.0.0.1:8/"),
  ])
    try {
      probe();
    } catch {
      denied++;
    }
  if (denied !== 2) throw new Error("Panel scope fixture network guard is inactive");
  return denied;
}
