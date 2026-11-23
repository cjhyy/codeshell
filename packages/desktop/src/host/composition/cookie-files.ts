import { constants, closeSync, fstatSync, openSync, writeFileSync } from "node:fs";
import { cookieLeasePath, sweepStaleLeases } from "../cookie-lease-path.js";
import {
  formatNetscapeCookies,
  parseCookieJar,
  summarizeCookieExpiry,
  sweepStaleCredentialCookies,
} from "@cjhyy/code-shell-core";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type {
  CookieFileOperations,
  CookieInspection,
  CookieLease,
} from "../../shared/cookie-files.js";
import { claimBusinessCommit, type BusinessMethods } from "./business-calls.js";

function inspect(secret: string): CookieInspection {
  let health: CookieInspection["health"] = "corrupted";
  try {
    if (Array.isArray(JSON.parse(secret))) health = "ready";
  } catch {
    // A locked or malformed jar can still be listed and replaced.
  }
  return { health, cookieExpiry: summarizeCookieExpiry(secret) };
}

function writeCookieLease(lease: CookieLease, secret: string, permit: Int32Array) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) > 16 * 1024 * 1024)
    throw Error("Invalid Cookie credential");
  const jar = parseCookieJar(secret);
  if (!jar.length) throw Error("Cookie jar is empty or invalid");
  const contents = formatNetscapeCookies(jar);
  // Main creates the empty owner-only lease. A delayed worker must never recreate
  // a released lease or write to a replacement, link, FIFO or inherited file.
  const fd = openSync(
    cookieLeasePath(lease.token),
    constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const st = fstatSync(fd, { bigint: true });
    if (
      !st.isFile() ||
      st.nlink !== 1n ||
      st.size !== 0n ||
      st.dev.toString() !== lease.device ||
      st.ino.toString() !== lease.inode ||
      (process.platform !== "win32" &&
        ((st.mode & 0o077n) !== 0n || (process.getuid && st.uid !== BigInt(process.getuid()))))
    )
      throw Error("Cookie lease changed");
    claimBusinessCommit(permit);
    writeFileSync(fd, contents);
    return jar.length;
  } finally {
    closeSync(fd);
  }
}

type Method = keyof CookieFileOperations;
interface CookieWork {
  input: CookieFileOperations[Method]["input"];
  permit: Int32Array;
}

export function runCookieFileWork(method: Method, { input, permit }: CookieWork) {
  if (method === "cookies/sweep") {
    claimBusinessCommit(permit);
    sweepStaleLeases();
    sweepStaleCredentialCookies();
    return true;
  }
  if (method === "cookies/inspect" && "secrets" in input && Array.isArray(input.secrets)) {
    if (
      input.secrets.length > 8192 ||
      input.secrets.some(
        (secret) => typeof secret !== "string" || Buffer.byteLength(secret) > 16 * 1024 * 1024,
      )
    )
      throw Error("Invalid Cookie list");
    claimBusinessCommit(permit);
    return input.secrets.map(inspect);
  }
  if (method === "cookies/materialize" && "lease" in input && "secret" in input)
    return writeCookieLease(input.lease as CookieLease, input.secret as string, permit);
  throw Error("Invalid Cookie file operation");
}

export function cookieFileOperations(storage: Promise<Pick<StateStorage, "request">>) {
  function handle<K extends Method>(method: K) {
    return async (
      input: CookieFileOperations[K]["input"],
      grant: Parameters<BusinessMethods[K]>[1],
    ) => {
      const db = await storage;
      grant.assertCurrent();
      const result = await db.request<CookieFileOperations[K]["result"]>(method, {
        input,
        permit: grant.permit,
      });
      if (result === null) throw Error("Cookie storage unavailable");
      return result;
    };
  }
  return {
    "cookies/materialize": handle("cookies/materialize"),
    "cookies/inspect": handle("cookies/inspect"),
    "cookies/sweep": handle("cookies/sweep"),
  } satisfies Pick<BusinessMethods, Method>;
}
