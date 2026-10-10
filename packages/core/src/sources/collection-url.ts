import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import { MAX_DOCUMENT_BYTES } from "./documents/types.js";

const MAX_URL_LENGTH = 8_192;
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const HEX = /^[a-f0-9]{64}$/;

export interface CollectionUrlProof {
  requestedUrl: string;
  finalUrl: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
}

export interface CollectionUrlInput {
  url: string;
  expected?: { sizeBytes: number; sha256: string };
}

export interface CollectionUrlOptions {
  signal?: AbortSignal;
  assertAuthorized?: () => void;
}

export interface CollectionUrlDownload {
  bytes: Uint8Array;
  proof: CollectionUrlProof;
}

/** Pure validation: listing a saved URL must never resolve DNS or make a request. */
export function normalizeCollectionUrl(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > MAX_URL_LENGTH ||
    /[\s\u0000-\u001f\u007f]/.test(raw)
  )
    throw new Error("A bounded HTTPS static-file URL is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid static-file URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Static-file URLs require HTTPS without credentials or fragments");
  if (!url.hostname || url.pathname.endsWith("/"))
    throw new Error("Select a static file URL, not a directory");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host.endsWith(".") ||
    /(^|\.)(localhost|local|internal|home|lan)$/.test(host) ||
    (!isIP(host) && !host.includes(".")) ||
    (isIP(host) && !isPublicAddress(host))
  )
    throw new Error("Static-file URL must target a public host");
  if (url.href.length > MAX_URL_LENGTH) throw new Error("Static-file URL exceeds its length limit");
  return url.href;
}

function ipv6Words(ip: string): number[] {
  let text = ip.toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (tail) {
    const parts = tail.split(".").map(Number);
    text =
      text.slice(0, -tail.length) +
      ((parts[0] << 8) | parts[1]).toString(16) +
      ":" +
      ((parts[2] << 8) | parts[3]).toString(16);
  }
  const [left, right] = text.split("::");
  const a = left ? left.split(":").map((part) => parseInt(part, 16)) : [];
  if (right === undefined) return a;
  const b = right ? right.split(":").map((part) => parseInt(part, 16)) : [];
  return [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
}

function canonicalAddress(ip: string): string {
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6 || ip.includes("%")) return "";
  const words = ipv6Words(ip);
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
    return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  return words.map((word) => word.toString(16)).join(":");
}

function isPublicAddress(ip: string): boolean {
  const normalized = canonicalAddress(ip);
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (!normalized) return false;
  const [a, b] = ipv6Words(ip);
  // Public global unicast only. Exclude transition, special-purpose and documentation ranges.
  return (
    (a & 0xe000) === 0x2000 &&
    a !== 0x2002 &&
    !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) &&
    !(a === 0x3fff && (b & 0xf000) === 0)
  );
}

interface ResolvedAddress {
  address: string;
  family: number;
}
interface TransportDependencies {
  lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  request: typeof https.request;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}

const nativeDependencies: TransportDependencies = {
  lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  // Resolve the native method when invoked, so a fixture guard restored by a
  // different test file cannot remain captured in this module's cached closure.
  request: ((...args: Parameters<typeof https.request>) =>
    https.request(...args)) as typeof https.request,
  setTimer: setTimeout,
  clearTimer: clearTimeout,
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Static-file download cancelled", "AbortError");
}

async function resolveAddresses(
  host: string,
  dependencies: TransportDependencies,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  // OS DNS lookup itself is not cancellable. A late result can never start an HTTP request.
  const addresses = await new Promise<ResolvedAddress[]>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => dependencies.lookup(host))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.length > 64 ||
    addresses.some(
      (entry) => !isPublicAddress(entry.address) || isIP(entry.address) !== entry.family,
    )
  )
    throw new Error("Static-file DNS must resolve only to public addresses");
  return addresses;
}

type Hop = { redirect: string } | { bytes: Buffer; sha256: string; mimeType: string };

function readHop(
  url: URL,
  address: ResolvedAddress,
  dependencies: TransportDependencies,
  signal: AbortSignal,
  assertAuthorized: () => void,
): Promise<Hop> {
  return new Promise((resolve, reject) => {
    let request: ReturnType<typeof https.request> | undefined;
    let response: IncomingMessage | undefined;
    let requestClosed = false,
      responseClosed = false,
      ended = false;
    let outcome: Hop | undefined,
      failure: unknown,
      failed = false;
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let bytes = 0,
      expectedLength: number | undefined;
    const finish = () => {
      if (!requestClosed || (response && !responseClosed)) return;
      signal.removeEventListener("abort", onAbort);
      if (failed) reject(failure);
      else if (outcome) resolve(outcome);
      else reject(new Error("Static-file connection closed before completion"));
    };
    const stop = (cause: unknown) => {
      if (!failed) {
        failed = true;
        failure = cause;
      }
      response?.destroy();
      request?.destroy();
      if (!request) {
        requestClosed = true;
        finish();
      }
    };
    const onAbort = () => stop(abortReason(signal));
    const checkConnection = (socket: TLSSocket) => {
      assertAuthorized();
      signal.throwIfAborted();
      if (
        socket.authorized !== true ||
        canonicalAddress(socket.remoteAddress ?? "") !== canonicalAddress(address.address)
      )
        throw new Error("Static-file TLS connection did not match its verified public address");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      assertAuthorized();
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const requestOptions: https.RequestOptions & { autoSelectFamily: false } = {
        protocol: "https:",
        hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        agent: false,
        rejectUnauthorized: true,
        servername: isIP(hostname) ? undefined : hostname,
        family: address.family,
        autoSelectFamily: false,
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity" },
      };
      request = dependencies.request(requestOptions, (incoming) => {
        response = incoming;
        incoming.on("error", stop);
        incoming.once("aborted", () => {
          if (!outcome) stop(new Error("Static-file response was interrupted"));
        });
        incoming.once("close", () => {
          responseClosed = true;
          finish();
        });
        try {
          checkConnection(incoming.socket as TLSSocket);
          const status = incoming.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = incoming.headers.location;
            if (!location || location.length > MAX_URL_LENGTH)
              throw new Error("Invalid static-file redirect");
            outcome = { redirect: new URL(location, url).href };
            incoming.destroy();
            request!.destroy();
            return;
          }
          if (status !== 200) throw new Error(`Static-file download returned HTTP ${status}`);
          const encoding = incoming.headers["content-encoding"];
          if (encoding && encoding !== "identity")
            throw new Error("Compressed static-file transfers are not supported");
          const rawLength = incoming.headers["content-length"];
          if (rawLength !== undefined) {
            if (!/^\d+$/.test(rawLength) || BigInt(rawLength) > BigInt(MAX_DOCUMENT_BYTES))
              throw new Error("Static file exceeds the 20 MiB download limit");
            expectedLength = Number(rawLength);
          }
          const mimeType = (incoming.headers["content-type"] ?? "application/octet-stream")
            .split(";")[0]
            .trim()
            .toLowerCase();
          if (mimeType.length > 256 || ["text/html", "application/xhtml+xml"].includes(mimeType))
            throw new Error("Select a static document, not an HTML page");
          incoming.on("data", (chunk: Buffer) => {
            if (failed) return;
            try {
              assertAuthorized();
              signal.throwIfAborted();
              if (chunk.length > MAX_DOCUMENT_BYTES - bytes)
                throw new Error("Static file exceeds the 20 MiB download limit");
              bytes += chunk.length;
              hash.update(chunk);
              chunks.push(chunk);
            } catch (cause) {
              stop(cause);
            }
          });
          incoming.once("end", () => {
            ended = true;
            try {
              assertAuthorized();
              signal.throwIfAborted();
              if (!incoming.complete || (expectedLength !== undefined && bytes !== expectedLength))
                throw new Error("Static-file download length does not match its response");
              outcome = {
                bytes: Buffer.concat(chunks, bytes),
                sha256: hash.digest("hex"),
                mimeType,
              };
              request!.destroy();
              finish();
            } catch (cause) {
              stop(cause);
            }
          });
          incoming.once("close", () => {
            if (!ended && !failed && !outcome)
              stop(new Error("Static-file response closed before completion"));
          });
        } catch (cause) {
          stop(cause);
        }
      });
      request.on("error", stop);
      request.once("close", () => {
        requestClosed = true;
        finish();
      });
      request.on("socket", (socket) => {
        socket.once("secureConnect", () => {
          try {
            checkConnection(socket as TLSSocket);
          } catch (cause) {
            stop(cause);
          }
        });
      });
      request.end();
    } catch (cause) {
      stop(cause);
    }
  });
}

function createDownloader(dependencies: TransportDependencies) {
  return async (
    input: CollectionUrlInput,
    options: CollectionUrlOptions = {},
  ): Promise<CollectionUrlDownload> => {
    const requestedUrl = normalizeCollectionUrl(input.url);
    const expected = input.expected
      ? { sizeBytes: input.expected.sizeBytes, sha256: input.expected.sha256 }
      : undefined;
    if (
      expected &&
      (!Number.isSafeInteger(expected.sizeBytes) ||
        expected.sizeBytes < 0 ||
        expected.sizeBytes > MAX_DOCUMENT_BYTES ||
        typeof expected.sha256 !== "string" ||
        !HEX.test(expected.sha256))
    )
      throw new Error("Invalid saved static-file size/hash proof");
    const userSignal = options.signal;
    const assertAuthorized = options.assertAuthorized ?? (() => {});
    const controller = new AbortController();
    const onAbort = () => controller.abort(userSignal!.reason);
    userSignal?.addEventListener("abort", onAbort, { once: true });
    if (userSignal?.aborted) onAbort();
    const timer = dependencies.setTimer(
      () => controller.abort(new Error("Static-file download exceeded its 30 second time limit")),
      TIMEOUT_MS,
    );
    try {
      let current = new URL(requestedUrl);
      for (let redirects = 0; ; redirects++) {
        controller.signal.throwIfAborted();
        assertAuthorized();
        const addresses = await resolveAddresses(
          current.hostname.replace(/^\[|\]$/g, ""),
          dependencies,
          controller.signal,
        );
        const result = await readHop(
          current,
          addresses[0],
          dependencies,
          controller.signal,
          assertAuthorized,
        );
        if ("redirect" in result) {
          const next = new URL(normalizeCollectionUrl(result.redirect));
          if (next.origin !== new URL(requestedUrl).origin)
            throw new Error("Static-file redirects must remain on the original HTTPS origin");
          if (redirects >= MAX_REDIRECTS) throw new Error("Static-file redirect limit exceeded");
          current = next;
          continue;
        }
        controller.signal.throwIfAborted();
        assertAuthorized();
        if (
          expected &&
          (result.bytes.length !== expected.sizeBytes || result.sha256 !== expected.sha256)
        )
          throw new Error("Static file changed; refresh the collection entry before reading it");
        return {
          bytes: result.bytes,
          proof: {
            requestedUrl,
            finalUrl: current.href,
            sizeBytes: result.bytes.length,
            sha256: result.sha256,
            mimeType: result.mimeType,
          },
        };
      }
    } finally {
      dependencies.clearTimer(timer);
      userSignal?.removeEventListener("abort", onAbort);
    }
  };
}

/** Native, credential-free transport. No caller-supplied dispatcher, proxy, headers or TLS policy. */
export const downloadCollectionUrl = createDownloader(nativeDependencies);

/** Internal fixture seam only; never re-export from an SDK or accept through RPC/renderer input. */
export function createCollectionUrlDownloaderForTests(dependencies: TransportDependencies) {
  return createDownloader(dependencies);
}
