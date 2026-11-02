/** Device relay v1. The relay terminates TLS and is a trusted transport. */
export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_CONTROL_MAX_BYTES = 16 * 1024;
export const RELAY_DATA_MAX_BYTES = 64 * 1024;
export const RELAY_DATA_CHUNK_BYTES = 32 * 1024;
export const RELAY_MAX_STREAMS = 32;
export const RELAY_CONNECT_PATH = "/api/v1/remote-hosts/connect";
export const RELAY_STREAMS_PATH = "/api/v1/remote-hosts/streams/";
export const RELAY_SETUP_TIMEOUT_MS = 10_000;
export const RELAY_PING_INTERVAL_MS = 20_000;
export const RELAY_PONG_TIMEOUT_MS = 60_000;
/** Control-upgrade header listing optional features; older directories ignore it. */
export const RELAY_FEATURES_HEADER = "X-CodeShell-Relay-Features";
/** The directory may ask this computer for a one-time phone pairing token. */
export const RELAY_FEATURE_PAIRING = "pairing";

export type RelayControlMessage =
  | { type: "welcome"; v: 1; hostId: string; publicOrigin: string; leaseId: string }
  | { type: "ready"; v: 1; leaseId: string }
  | { type: "open"; v: 1; leaseId: string; streamId: string; ticket: string }
  | { type: "failed"; v: 1; leaseId: string; streamId: string }
  | { type: "pair"; v: 1; leaseId: string; requestId: string }
  | {
      type: "paired";
      v: 1;
      leaseId: string;
      requestId: string;
      token: string;
      expiresAt: number;
    }
  | { type: "pair-failed"; v: 1; leaseId: string; requestId: string };

export function isRelayToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function isRelayHostId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

/** Canonical HTTPS origin only: no credentials, path, fragment or query. */
export function isRelayOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Validate an already JSON-decoded message; wire size/direction are checked by its receiver. */
export function parseRelayControlMessage(value: unknown): RelayControlMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const message = value as Record<string, unknown>;
  if (message.v !== RELAY_PROTOCOL_VERSION || !isRelayToken(message.leaseId)) return;
  switch (message.type) {
    case "welcome":
      if (isRelayHostId(message.hostId) && isRelayOrigin(message.publicOrigin))
        return {
          type: "welcome",
          v: 1,
          leaseId: message.leaseId,
          hostId: message.hostId,
          publicOrigin: message.publicOrigin,
        };
      return;
    case "ready":
      return { type: "ready", v: 1, leaseId: message.leaseId };
    case "open":
      if (isRelayToken(message.streamId) && isRelayToken(message.ticket))
        return {
          type: "open",
          v: 1,
          leaseId: message.leaseId,
          streamId: message.streamId,
          ticket: message.ticket,
        };
      return;
    case "failed":
      if (isRelayToken(message.streamId))
        return { type: "failed", v: 1, leaseId: message.leaseId, streamId: message.streamId };
      return;
    case "pair":
      if (isRelayToken(message.requestId))
        return { type: "pair", v: 1, leaseId: message.leaseId, requestId: message.requestId };
      return;
    case "paired":
      if (
        isRelayToken(message.requestId) &&
        isRelayToken(message.token) &&
        Number.isSafeInteger(message.expiresAt) &&
        (message.expiresAt as number) > 0
      )
        return {
          type: "paired",
          v: 1,
          leaseId: message.leaseId,
          requestId: message.requestId,
          token: message.token,
          expiresAt: message.expiresAt as number,
        };
      return;
    case "pair-failed":
      if (isRelayToken(message.requestId))
        return {
          type: "pair-failed",
          v: 1,
          leaseId: message.leaseId,
          requestId: message.requestId,
        };
  }
}
