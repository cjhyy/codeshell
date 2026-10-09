import children from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, realpathSync } from "node:fs";
import http from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

/** Only an exact, live owned inspector endpoint may use this direct transport. */
export function ownedControlRequest(direct, guarded, endpoints) {
  return function (input, ...args) {
    const isUrl = typeof input === "string" || input instanceof URL;
    const url = isUrl ? new URL(input) : undefined;
    const options = isUrl ? (args[0] && typeof args[0] === "object" ? args[0] : {}) : (input ?? {});
    const protocol = options.protocol ?? url?.protocol ?? "http:";
    const hostname = options.hostname ?? options.host ?? url?.hostname;
    const port = options.port ?? url?.port;
    const path = options.path ?? (url ? `${url.pathname}${url.search}` : "/");
    const target = `${protocol}//${hostname}:${port}${path}`;
    const owner = endpoints.get(target);
    const headers = options.headers ?? {};
    const upgrade = Object.entries(headers).find(([key]) => key.toLowerCase() === "upgrade")?.[1];
    if (
      owner?.active &&
      protocol === "http:" &&
      hostname === "127.0.0.1" &&
      (options.method ?? "GET") === "GET" &&
      String(upgrade).toLowerCase() === "websocket" &&
      !options.socketPath
    ) {
      // ws supplies a connection factory/agent. Do not trust those transports:
      // reconstruct the request using the observed loopback URL and native TCP.
      const cleanHeaders = Object.fromEntries(
        Object.entries(headers).filter(([key]) => key.toLowerCase() !== "host"),
      );
      cleanHeaders.Host = new URL(target).host;
      const callback = args.find((value) => typeof value === "function");
      owner.onUpgrade?.(target);
      return direct.call(
        this,
        new URL(target),
        {
          method: "GET",
          headers: cleanHeaders,
          agent: false,
        },
        ...(callback ? [callback] : []),
      );
    }
    return guarded.call(this, input, ...args);
  };
}

/** Install before the provider guard so its native HTTP function stays private. */
export function prepareOwnedElectronControl({ appDir, mainEntry, home, receiptFile }) {
  const direct = http.request;
  const executable = realpathSync(createRequire(join(appDir, "package.json"))("electron"));
  const endpoints = new Map();
  const spawn = children.spawn;
  children.spawn = function (command, args, options) {
    const child = spawn.call(this, command, args, options);
    let matching = false;
    try {
      matching =
        realpathSync(command) === executable &&
        args?.includes(mainEntry) &&
        options?.env?.HOME === home;
    } catch {
      /* Other toolchain commands are not control authorities. */
    }
    if (!matching || !child.pid) return child;
    const owner = {
      pid: child.pid,
      active: true,
      onUpgrade(target) {
        const url = new URL(target);
        appendFileSync(
          receiptFile,
          `${JSON.stringify({
            action: "used",
            pid: process.pid,
            electronPid: child.pid,
            port: +url.port,
            pathHash: createHash("sha256").update(url.pathname).digest("hex"),
          })}\n`,
          { mode: 0o600 },
        );
      },
    };
    const observed = new Set();
    let buffer = "";
    child.stderr?.prependListener("data", (chunk) => {
      if (!owner.active) return;
      buffer = `${buffer}${chunk.toString()}`.slice(-16_384);
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const match = line
          .trim()
          .match(
            /^(Debugger|DevTools) listening on (ws:\/\/127\.0\.0\.1:\d+\/(?:devtools\/browser\/)?[a-f0-9-]{36})$/,
          );
        if (!match) continue;
        const url = new URL(match[2]);
        const target = `http://${url.host}${url.pathname}`;
        endpoints.set(target, owner);
        observed.add(target);
        appendFileSync(
          receiptFile,
          `${JSON.stringify({
            action: "observed",
            pid: process.pid,
            electronPid: child.pid,
            kind: match[1],
            port: +url.port,
            pathHash: createHash("sha256").update(url.pathname).digest("hex"),
          })}\n`,
          { mode: 0o600 },
        );
      }
    });
    child.once("exit", () => {
      owner.active = false;
      for (const target of observed) if (endpoints.get(target) === owner) endpoints.delete(target);
      appendFileSync(
        receiptFile,
        `${JSON.stringify({
          action: "revoked",
          pid: process.pid,
          electronPid: child.pid,
        })}\n`,
        { mode: 0o600 },
      );
    });
    return child;
  };
  syncBuiltinESMExports();
  return {
    activate() {
      http.request = ownedControlRequest(direct, http.request, endpoints);
      syncBuiltinESMExports();
    },
  };
}
