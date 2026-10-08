import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const marker = Symbol.for("codeshell.cost-smoke.network-guard");

/** Test-only confinement installed before loading any Core/host code. */
export function installLocalNetworkGuard(origin) {
  const allowed = new URL(origin);
  if (
    allowed.protocol !== "http:" ||
    allowed.hostname !== "127.0.0.1" ||
    !allowed.port ||
    allowed.origin !== origin
  )
    throw new Error("Cost smoke requires an exact HTTP loopback origin");
  if (globalThis[marker]) {
    if (globalThis[marker] !== origin) throw new Error("Cost smoke origin changed");
    return;
  }
  const assertOrigin = (value) => {
    if (new URL(value).origin !== origin)
      throw new Error("Cost smoke refused a non-fixture request");
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    assertOrigin(typeof input === "string" || input instanceof URL ? input : input.url);
    if (init?.dispatcher) throw new Error("Cost smoke refused a custom fetch dispatcher");
    return originalFetch(input, { ...init, redirect: "error" });
  };
  for (const [module, protocol] of [
    [http, "http:"],
    [https, "https:"],
  ]) {
    const originalRequest = module.request;
    const originalGet = module.get;
    const check = (input, second) => {
      const isUrl = typeof input === "string" || input instanceof URL;
      const url = isUrl ? new URL(input) : undefined;
      const options = isUrl
        ? typeof second === "object" && second !== null
          ? second
          : {}
        : (input ?? {});
      if (options.socketPath || options.createConnection || options.lookup || options.agent)
        throw new Error("Cost smoke refused a custom HTTP transport");
      const scheme = options.protocol ?? url?.protocol ?? protocol;
      const hostname = options.hostname ?? options.host ?? url?.hostname ?? "localhost";
      const port = options.port ?? url?.port ?? (scheme === "https:" ? "443" : "80");
      assertOrigin(`${scheme}//${hostname}:${port}`);
    };
    module.request = function (input, ...args) {
      check(input, args[0]);
      return originalRequest.call(this, input, ...args);
    };
    module.get = function (input, ...args) {
      check(input, args[0]);
      return originalGet.call(this, input, ...args);
    };
  }
  syncBuiltinESMExports();
  globalThis[marker] = origin;
}

/** Every nested Node worker inherits these restrictions and its private child home. */
export function confinedWorkerEnvironment(base, fixtureUserHome, origin, preloadUrl) {
  const environment = { ...base };
  for (const key of Object.keys(environment))
    if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete environment[key];
  return {
    ...environment,
    HOME: fixtureUserHome,
    USERPROFILE: fixtureUserHome,
    NODE_OPTIONS: `--import ${preloadUrl}`,
    NODE_USE_ENV_PROXY: "0",
    CODESHELL_COST_SMOKE_ORIGIN: origin,
    CODESHELL_COST_SMOKE_HOME_ID: createHash("sha256").update(fixtureUserHome).digest("hex"),
  };
}

if (process.env.CODESHELL_COST_SMOKE_ORIGIN) {
  if (
    process.env.CODESHELL_COST_SMOKE_HOME_ID !==
    createHash("sha256")
      .update(process.env.HOME ?? "")
      .digest("hex")
  )
    throw new Error("Cost smoke refused an unexpected worker home");
  installLocalNetworkGuard(process.env.CODESHELL_COST_SMOKE_ORIGIN);
  if (process.env.CODESHELL_COST_SMOKE_GUARD_LOG)
    appendFileSync(
      process.env.CODESHELL_COST_SMOKE_GUARD_LOG,
      JSON.stringify({
        pid: process.pid,
        ppid: process.ppid,
        origin: process.env.CODESHELL_COST_SMOKE_ORIGIN,
        homeId: createHash("sha256")
          .update(process.env.HOME ?? "")
          .digest("hex"),
      }) + "\n",
      { mode: 0o600 },
    );
}
