import { randomUUID } from "node:crypto";
import { createHardenedOAuthFetch } from "@cjhyy/code-shell-core";

export type LocalBrowserLinkProviderId = "github" | "gitlab";

export interface LocalBrowserAuthStatus {
  providerId: LocalBrowserLinkProviderId;
  configured: boolean;
  flow: "device-code";
  configurationCode?: "client_id_missing";
}

export interface LocalBrowserAuthPrompt {
  attemptId: string;
  providerId: LocalBrowserLinkProviderId;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: string;
}

export interface LocalBrowserAuthToken {
  providerId: LocalBrowserLinkProviderId;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshTokenExpiresIn?: number;
  clientId: string;
  tokenEndpoint: string;
  tokenType: "Bearer";
  scope?: string;
}

interface ProviderDeviceConfig {
  clientIdEnvironmentKey: string;
  deviceEndpoint: string;
  tokenEndpoint: string;
  verificationHosts: readonly string[];
  scopes?: readonly string[];
}

interface PendingAttempt {
  providerId: LocalBrowserLinkProviderId;
  clientId: string;
  deviceCode: string;
  tokenEndpoint: string;
  expiresAtMs: number;
  intervalMs: number;
  abortController: AbortController;
}

interface LinkDeviceOAuthBrokerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  createId?: () => string;
  clientIds?: Partial<Record<LocalBrowserLinkProviderId, string>>;
  environment?: Record<string, string | undefined>;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MAX_RESPONSE_BYTES = 64 * 1024;

const PROVIDERS: Record<LocalBrowserLinkProviderId, ProviderDeviceConfig> = {
  github: {
    clientIdEnvironmentKey: "CODESHELL_GITHUB_APP_CLIENT_ID",
    deviceEndpoint: "https://github.com/login/device/code",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    verificationHosts: ["github.com"],
    // A GitHub App user token uses the App's fine-grained permissions rather
    // than OAuth scopes, so no scope parameter is sent.
  },
  gitlab: {
    clientIdEnvironmentKey: "CODESHELL_GITLAB_OAUTH_CLIENT_ID",
    deviceEndpoint: "https://gitlab.com/oauth/authorize_device",
    tokenEndpoint: "https://gitlab.com/oauth/token",
    verificationHosts: ["gitlab.com"],
    scopes: ["read_api"],
  },
};

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Browser login cancelled"));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Browser login cancelled"));
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function form(values: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) body.set(key, value);
  }
  return body;
}

async function safeJson(
  response: Response,
  action: string,
  allowOAuthError = false,
): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) throw new Error(`${action} response is too large`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${action} returned invalid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${action} returned an invalid response`);
  }
  const record = parsed as Record<string, unknown>;
  if (!response.ok && !(allowOAuthError && typeof record.error === "string")) {
    throw new Error(`${action} failed (${response.status})`);
  }
  return record;
}

function requiredString(value: unknown, field: string, action: string, maxLength = 16_384): string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new Error(`${action} response is missing ${field}`);
  }
  return value;
}

function finiteSeconds(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function verifiedHttpsUrl(raw: unknown, field: string, allowedHosts: readonly string[]): string {
  const value = requiredString(raw, field, "Device authorization", 2_048);
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Device authorization returned an invalid ${field}`, { cause: error });
  }
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`Device authorization returned an untrusted ${field}`);
  }
  return url.toString();
}

export function isLocalBrowserLinkProvider(value: string): value is LocalBrowserLinkProviderId {
  return value === "github" || value === "gitlab";
}

/** Main-process-only broker. Provider tokens never cross the renderer IPC. */
export class LinkDeviceOAuthBroker {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly createId: () => string;
  private readonly clientIds: Partial<Record<LocalBrowserLinkProviderId, string>>;
  private readonly environment: Record<string, string | undefined>;
  private readonly attempts = new Map<string, PendingAttempt>();

  constructor(options: LinkDeviceOAuthBrokerOptions = {}) {
    this.fetchFn = createHardenedOAuthFetch(options.fetch ?? fetch);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.createId = options.createId ?? randomUUID;
    this.clientIds = options.clientIds ?? {};
    this.environment = options.environment ?? process.env;
  }

  status(providerId: LocalBrowserLinkProviderId): LocalBrowserAuthStatus {
    return {
      providerId,
      configured: Boolean(this.clientId(providerId)),
      flow: "device-code",
      ...(this.clientId(providerId) ? {} : { configurationCode: "client_id_missing" as const }),
    };
  }

  async start(providerId: LocalBrowserLinkProviderId): Promise<LocalBrowserAuthPrompt> {
    const config = PROVIDERS[providerId];
    const clientId = this.clientId(providerId);
    if (!clientId) throw new Error(`${providerId} browser login is not configured in this build`);

    for (const [attemptId, attempt] of this.attempts) {
      if (attempt.providerId === providerId) this.cancel(attemptId);
    }

    const body = form({
      client_id: clientId,
      scope: config.scopes?.join(" "),
    });
    const response = await this.fetchFn(config.deviceEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await safeJson(response, "Device authorization");
    const deviceCode = requiredString(payload.device_code, "device_code", "Device authorization");
    const userCode = requiredString(payload.user_code, "user_code", "Device authorization", 128);
    const verificationUri = verifiedHttpsUrl(
      payload.verification_uri,
      "verification_uri",
      config.verificationHosts,
    );
    const verificationUriComplete = payload.verification_uri_complete
      ? verifiedHttpsUrl(
          payload.verification_uri_complete,
          "verification_uri_complete",
          config.verificationHosts,
        )
      : undefined;
    const expiresIn = finiteSeconds(payload.expires_in, 600, 1_800);
    const interval = finiteSeconds(payload.interval, 5, 30);
    const attemptId = this.createId();
    const expiresAtMs = this.now() + expiresIn * 1_000;
    this.attempts.set(attemptId, {
      providerId,
      clientId,
      deviceCode,
      tokenEndpoint: config.tokenEndpoint,
      expiresAtMs,
      intervalMs: interval * 1_000,
      abortController: new AbortController(),
    });
    return {
      attemptId,
      providerId,
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async complete(attemptId: string): Promise<LocalBrowserAuthToken> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error("Browser login attempt is unavailable or expired");
    let intervalMs = attempt.intervalMs;
    try {
      while (this.now() < attempt.expiresAtMs) {
        await this.sleep(intervalMs, attempt.abortController.signal);
        const response = await this.fetchFn(attempt.tokenEndpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form({
            client_id: attempt.clientId,
            device_code: attempt.deviceCode,
            grant_type: DEVICE_GRANT,
          }),
          signal: AbortSignal.any([attempt.abortController.signal, AbortSignal.timeout(15_000)]),
        });
        const payload = await safeJson(response, "Device token exchange", true);
        if (typeof payload.access_token === "string" && payload.access_token) {
          const tokenType =
            typeof payload.token_type === "string" ? payload.token_type.toLowerCase() : "bearer";
          if (tokenType !== "bearer")
            throw new Error("Device token exchange returned non-Bearer token");
          return {
            providerId: attempt.providerId,
            accessToken: requiredString(
              payload.access_token,
              "access_token",
              "Device token exchange",
            ),
            refreshToken:
              typeof payload.refresh_token === "string" && payload.refresh_token
                ? requiredString(payload.refresh_token, "refresh_token", "Device token exchange")
                : undefined,
            expiresIn:
              typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
                ? Math.max(0, payload.expires_in)
                : undefined,
            refreshTokenExpiresIn:
              typeof payload.refresh_token_expires_in === "number" &&
              Number.isFinite(payload.refresh_token_expires_in)
                ? Math.max(0, payload.refresh_token_expires_in)
                : undefined,
            clientId: attempt.clientId,
            tokenEndpoint: attempt.tokenEndpoint,
            tokenType: "Bearer",
            scope: typeof payload.scope === "string" ? payload.scope : undefined,
          };
        }
        const error = typeof payload.error === "string" ? payload.error : "invalid_response";
        if (error === "authorization_pending") continue;
        if (error === "slow_down") {
          intervalMs = Math.min(intervalMs + 5_000, 60_000);
          continue;
        }
        if (error === "access_denied") throw new Error("Browser authorization was denied");
        if (error === "expired_token" || error === "token_expired") {
          throw new Error("Browser authorization code expired");
        }
        throw new Error(`Browser authorization failed (${error})`);
      }
      throw new Error("Browser authorization code expired");
    } finally {
      this.attempts.delete(attemptId);
    }
  }

  cancel(attemptId: string): boolean {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return false;
    this.attempts.delete(attemptId);
    attempt.abortController.abort("Browser login cancelled");
    return true;
  }

  private clientId(providerId: LocalBrowserLinkProviderId): string | undefined {
    const explicit = this.clientIds[providerId]?.trim();
    if (explicit) return explicit;
    const environmentValue = this.environment[PROVIDERS[providerId].clientIdEnvironmentKey]?.trim();
    return environmentValue || undefined;
  }
}
