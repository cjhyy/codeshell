/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports -- Loaded by Node --require before application imports. */
/* Offline Electron fixture only. Never delegates an allowed request to a socket. */
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const DEFAULT_ACCOUNT_ORIGIN = "https://codeshell.site";
const STATUS_URL = `${DEFAULT_ACCOUNT_ORIGIN}/api/v1/account/status`;
const STATUS_BODY = JSON.stringify({
  registrationAllowed: false,
  githubEnabled: false,
  githubLinkEnabled: false,
  linkManagementEnabled: false,
  relay: { enabled: false },
  // An explicit empty map makes every feature unavailable.
  features: {},
});

function isOwnedDiscovery(input, options) {
  const url = input instanceof URL ? input.href : input;
  if (url !== STATUS_URL || !options || typeof options !== "object") return false;
  if (options.method !== "GET") return false;
  if (Object.keys(options).some((key) => !["method", "headers", "signal", "ca"].includes(key)))
    return false;
  if (options.ca !== undefined) return false;
  const headers = options.headers;
  if (!headers || Object.getPrototypeOf(headers) !== Object.prototype) return false;
  const seen = new Set();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === "origin" && value === DEFAULT_ACCOUNT_ORIGIN) continue;
    if (key === "accept" && value === "application/json") continue;
    // Includes Authorization, Cookie and Proxy-Authorization, regardless of case.
    return false;
  }
  return seen.has("origin") && seen.has("accept");
}

/** Install over an existing deny/count function, then syncBuiltinESMExports().
 * Only the production anonymous discovery request is synthesized. Every other
 * signature, endpoint, credential, body or transport retains the fixture's denial.
 */
function withOwnedAccountDiscovery(deny) {
  return function request(input, options, callback) {
    if (
      !isOwnedDiscovery(input, options) ||
      (callback !== undefined && typeof callback !== "function")
    )
      return deny.apply(this, arguments);
    const originalArguments = arguments;
    const req = new EventEmitter();
    let ended = false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      options.signal?.removeEventListener("abort", abort);
      req.emit("close");
    };
    req.destroy = (error) => {
      if (closed) return req;
      queueMicrotask(() => {
        if (closed) return;
        if (error) req.emit("error", error);
        close();
      });
      return req;
    };
    const abort = () => req.destroy(options.signal.reason ?? new Error("Aborted owned discovery"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    req.write = () => deny.apply(this, originalArguments);
    req.end = (body) => {
      if (body !== undefined || ended) return deny.apply(this, originalArguments);
      ended = true;
      queueMicrotask(() => {
        if (closed) return;
        const res = Readable.from([Buffer.from(STATUS_BODY)]);
        res.statusCode = 200;
        res.headers = { "content-type": "application/json", "cache-control": "no-store" };
        res.once("end", close);
        if (callback) req.once("response", callback);
        req.emit("response", res);
      });
      return req;
    };
    return req;
  };
}

module.exports = { withOwnedAccountDiscovery };
