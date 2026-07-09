import type { OAuthCredentialPublicStatus, OAuthCredentialSecret } from "./types.js";

const DEFAULT_OAUTH_REFRESH_SKEW_MS = 60_000;

export interface OAuthClockOptions {
  now?: number | (() => number);
  skewMs?: number;
}

export interface OAuthRefreshRequest {
  credentialId: string;
  tokenEndpoint: string;
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  scopes?: string[];
}

export type OAuthRefreshHandler = (req: OAuthRefreshRequest) => Promise<OAuthCredentialSecret>;

function nowMs(opts: OAuthClockOptions = {}): number {
  if (typeof opts.now === "function") return opts.now();
  if (typeof opts.now === "number") return opts.now;
  return Date.now();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : undefined;
}

function parseExpiresAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`OAuth credential secret has invalid expiresAt: ${value}`);
  }
  return ms;
}

export function parseOAuthCredentialSecret(secret: string): OAuthCredentialSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error("OAuth credential secret must be a JSON object");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OAuth credential secret must be a JSON object");
  }

  const raw = parsed as Record<string, unknown>;
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error("OAuth credential secret version must be 1");
  }

  const accessToken = optionalString(raw.accessToken);
  if (!accessToken) {
    throw new Error("OAuth credential secret must include accessToken");
  }

  const expiresAt = optionalString(raw.expiresAt);
  parseExpiresAt(expiresAt);

  return {
    version: raw.version === 1 ? 1 : undefined,
    accessToken,
    refreshToken: optionalString(raw.refreshToken),
    expiresAt,
    tokenType: optionalString(raw.tokenType),
    scope: optionalString(raw.scope),
    scopes: optionalStringArray(raw.scopes),
    tokenEndpoint: optionalString(raw.tokenEndpoint),
    clientId: optionalString(raw.clientId),
    clientSecret: optionalString(raw.clientSecret),
  };
}

export function isOAuthAccessTokenExpired(
  secret: Pick<OAuthCredentialSecret, "accessToken" | "expiresAt">,
  opts: OAuthClockOptions = {},
): boolean {
  const expiresAtMs = parseExpiresAt(secret.expiresAt);
  if (expiresAtMs === undefined) return false;
  const skewMs = opts.skewMs ?? DEFAULT_OAUTH_REFRESH_SKEW_MS;
  return expiresAtMs <= nowMs(opts) + skewMs;
}

export function oauthCredentialStatus(
  secret: Pick<OAuthCredentialSecret, "accessToken" | "expiresAt">,
  opts: OAuthClockOptions = {},
): Pick<OAuthCredentialPublicStatus, "state" | "expiresAt" | "expiresInMs"> {
  const expiresAtMs = parseExpiresAt(secret.expiresAt);
  if (expiresAtMs === undefined) {
    return { state: "valid", expiresAt: undefined, expiresInMs: undefined };
  }
  const expiresInMs = expiresAtMs - nowMs(opts);
  return {
    state: isOAuthAccessTokenExpired(secret, opts) ? "expired" : "valid",
    expiresAt: secret.expiresAt,
    expiresInMs,
  };
}

export function buildOAuthRefreshRequest(
  credentialId: string,
  secret: OAuthCredentialSecret,
): OAuthRefreshRequest | undefined {
  if (!secret.refreshToken || !secret.tokenEndpoint) return undefined;
  return {
    credentialId,
    tokenEndpoint: secret.tokenEndpoint,
    refreshToken: secret.refreshToken,
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    scope: secret.scope,
    scopes: secret.scopes,
  };
}

export function summarizeOAuthCredentialSecret(
  secret: string | undefined,
  opts: OAuthClockOptions = {},
): OAuthCredentialPublicStatus {
  if (!secret) return { state: "missing" };
  try {
    const parsed = parseOAuthCredentialSecret(secret);
    const status = oauthCredentialStatus(parsed, opts);
    return {
      ...status,
      hasRefreshToken: Boolean(parsed.refreshToken),
      tokenEndpoint: parsed.tokenEndpoint,
      clientId: parsed.clientId,
      scope: parsed.scope,
      scopes: parsed.scopes,
    };
  } catch (err) {
    return {
      state: "invalid",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
