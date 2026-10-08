import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Credential, OAuthCredentialSecret } from "../credentials/types.js";
import { CredentialStore } from "../credentials/store.js";
import {
  isBrowserOAuthLinkCredential,
  isOAuthAccessTokenExpired,
  parseOAuthCredentialSecret,
} from "../credentials/oauth.js";
import { getLocalLinkProvider } from "./providers.js";
import { LinkProviderHttpError } from "./http.js";
import { requestOnce } from "./request-once.js";

const ENDPOINTS: Record<string, { token: string; account: string }> = {
  github: {
    token: "https://github.com/login/oauth/access_token",
    account: "https://api.github.com/user",
  },
  gitlab: { token: "https://gitlab.com/oauth/token", account: "https://gitlab.com/api/v4/user" },
};
// Keep consumed-token receipts for this Host process. Never evict one to admit
// another rotation: old copied records must fail closed after the Promise settles.
const MAX_TRACKED_ROTATIONS = 4096;
const refreshes = new Map<string, { identity: string; pending?: Promise<void> }>();

export interface LocalOAuthLinkActionRequest {
  cwd?: string;
  id: string;
  scope: "full" | "project";
  accountId: string;
  verifiedAt: string;
  action: string;
  params: Record<string, unknown>;
}

export class LocalOAuthLinkError extends Error {
  constructor(readonly code: "invalid_request" | "changed" | "forbidden" | "reconnect" | "busy") {
    super(
      {
        invalid_request: "Invalid local OAuth Link request.",
        changed: "Local Link connection changed; select it again.",
        forbidden: "Local Link does not allow this action.",
        reconnect: "Local Link authorization requires reconnection.",
        busy: "Local Link refresh is incomplete; reconnect if the Host restarted.",
      }[code],
    );
    this.name = "LocalOAuthLinkError";
  }
}

function scopes(value: string | undefined): string[] {
  return value?.split(/[\s,]+/).filter(Boolean) ?? [];
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader)
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) {
          await reader.cancel();
          throw new LocalOAuthLinkError("reconnect");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder().decode(joined));
  } catch {
    throw new LocalOAuthLinkError("reconnect");
  }
  if (
    !response.ok ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    "error" in result
  )
    throw new LocalOAuthLinkError("reconnect");
  return result as Record<string, unknown>;
}

function boundedToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16384 &&
    !/[\x00-\x20\x7f]/.test(value)
  );
}

/** Execute in the credential owner's process; refresh material never crosses the worker seam. */
export async function executeLocalOAuthLinkAction(
  input: LocalOAuthLinkActionRequest,
  options: {
    store?: CredentialStore;
    signal?: AbortSignal;
    now?: () => number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.id !== "string" ||
    !input.id ||
    input.id.length > 512 ||
    (input.cwd !== undefined && typeof input.cwd !== "string") ||
    !["full", "project"].includes(input.scope) ||
    typeof input.accountId !== "string" ||
    !input.accountId ||
    typeof input.verifiedAt !== "string" ||
    !input.verifiedAt ||
    typeof input.action !== "string" ||
    !input.params ||
    typeof input.params !== "object" ||
    Array.isArray(input.params)
  )
    throw new LocalOAuthLinkError("invalid_request");
  const store = options.store ?? new CredentialStore(input.cwd);
  const now = options.now ?? Date.now;
  const send = options.fetchImpl ?? requestOnce;
  const read = (): Credential => {
    const credential = store.resolve(input.id, input.scope);
    if (
      !credential ||
      !isBrowserOAuthLinkCredential(credential) ||
      credential.meta?.linkExecutionRuntime !== "local" ||
      credential.meta.linkExecutionBackend === "cli" ||
      credential.meta.linkAccountId !== input.accountId ||
      credential.meta.linkLastVerifiedAt !== input.verifiedAt
    )
      throw new LocalOAuthLinkError("changed");
    if (
      credential.meta.linkOAuthState !== undefined &&
      !["connected", "refreshing"].includes(credential.meta.linkOAuthState)
    )
      throw new LocalOAuthLinkError("reconnect");
    return credential;
  };
  let current = read();
  const providerId = current.meta!.linkProvider ?? "";
  const endpoint = ENDPOINTS[providerId];
  const provider = getLocalLinkProvider(providerId);
  const action = provider?.actions.find((item) => item.id === input.action);
  if (!endpoint || !provider || !action) throw new LocalOAuthLinkError("forbidden");
  const layer = store.list("project").some((item) => item.id === input.id) ? "project" : "user";
  const assertAllowed = (credential: Credential) => {
    if (
      credential.meta?.linkProvider !== providerId ||
      !credential.meta.linkCapabilityIds?.includes(`${providerId}.${input.action}`)
    )
      throw new LocalOAuthLinkError("forbidden");
  };
  const parse = (credential: Credential): OAuthCredentialSecret => {
    let secret: OAuthCredentialSecret;
    try {
      secret = parseOAuthCredentialSecret(credential.secret ?? "");
    } catch {
      throw new LocalOAuthLinkError("reconnect");
    }
    if (
      !boundedToken(secret.accessToken) ||
      secret.tokenEndpoint !== endpoint.token ||
      !boundedToken(secret.clientId) ||
      secret.clientSecret
    )
      throw new LocalOAuthLinkError("reconnect");
    if (
      providerId === "gitlab" &&
      !scopes(secret.scope).some((scope) => scope === "read_api" || scope === "api")
    )
      throw new LocalOAuthLinkError("forbidden");
    return secret;
  };
  assertAllowed(current);
  let secret = parse(current);
  const refresh = async (rejected?: string) => {
    current = read();
    assertAllowed(current);
    secret = parse(current);
    if (
      rejected &&
      secret.accessToken !== rejected &&
      current.meta?.linkOAuthState !== "refreshing"
    )
      return;
    const original = current,
      previous = secret;
    if (
      !boundedToken(previous.refreshToken) ||
      (previous.refreshTokenExpiresAt && Date.parse(previous.refreshTokenExpiresAt) <= now())
    ) {
      store.compareAndSwap(layer, input.id, original, {
        ...original,
        meta: { ...original.meta, linkOAuthState: "reconnect" },
      });
      throw new LocalOAuthLinkError("reconnect");
    }
    const key = createHash("sha256").update(previous.refreshToken).digest("hex");
    const identity = store.recordIdentity(layer, input.id);
    let receipt = refreshes.get(key);
    if (
      (receipt && (receipt.identity !== identity || !receipt.pending)) ||
      (!receipt && refreshes.size >= MAX_TRACKED_ROTATIONS)
    ) {
      store.compareAndSwap(layer, input.id, original, {
        ...original,
        meta: { ...original.meta, linkOAuthState: "reconnect" },
      });
      throw new LocalOAuthLinkError("reconnect");
    }
    let pending = receipt?.pending;
    if (!pending) {
      if (original.meta?.linkOAuthState === "refreshing") throw new LocalOAuthLinkError("busy");
      pending = Promise.resolve()
        .then(async () => {
          const marked: Credential = {
            ...original,
            meta: { ...original.meta, linkOAuthState: "refreshing" },
          };
          if (!store.compareAndSwap(layer, input.id, original, marked))
            throw new LocalOAuthLinkError("changed");
          try {
            // A rotating request has one bounded attempt. Caller cancellation does not
            // replay or abort another caller's shared rotation. Persist before sending.
            const token = await json(
              await send(endpoint.token, {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(20_000),
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                  client_id: previous.clientId!,
                  grant_type: "refresh_token",
                  refresh_token: previous.refreshToken!,
                  ...(providerId === "gitlab" && previous.scope ? { scope: previous.scope } : {}),
                }),
              }),
            );
            if (
              !boundedToken(token.access_token) ||
              !boundedToken(token.refresh_token) ||
              (token.token_type !== undefined &&
                String(token.token_type).toLowerCase() !== "bearer") ||
              typeof token.expires_in !== "number" ||
              !Number.isFinite(token.expires_in) ||
              token.expires_in <= 0 ||
              token.expires_in > 31536000 ||
              (token.scope !== undefined && typeof token.scope !== "string")
            )
              throw new LocalOAuthLinkError("reconnect");
            const before = scopes(previous.scope);
            const after = token.scope === undefined ? before : scopes(token.scope as string);
            if (after.some((scope) => !before.includes(scope)))
              throw new LocalOAuthLinkError("reconnect");
            if (
              token.refresh_token_expires_in !== undefined &&
              (typeof token.refresh_token_expires_in !== "number" ||
                !Number.isFinite(token.refresh_token_expires_in) ||
                token.refresh_token_expires_in <= 0 ||
                token.refresh_token_expires_in > 31536000)
            )
              throw new LocalOAuthLinkError("reconnect");
            if (!isDeepStrictEqual(store.resolve(input.id, input.scope), marked))
              throw new LocalOAuthLinkError("changed");
            const account = await json(
              await send(endpoint.account, {
                redirect: "error",
                signal: AbortSignal.timeout(20_000),
                headers: {
                  Accept: "application/json",
                  Authorization: `Bearer ${token.access_token}`,
                  ...(providerId === "github" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
                },
              }),
            );
            if (
              !Number.isSafeInteger(account.id) ||
              Number(account.id) <= 0 ||
              String(account.id) !== input.accountId
            )
              throw new LocalOAuthLinkError("reconnect");
            const next: OAuthCredentialSecret = {
              ...previous,
              accessToken: token.access_token,
              refreshToken: token.refresh_token,
              expiresAt: new Date(now() + token.expires_in * 1000).toISOString(),
              tokenType: "Bearer",
              scope: after.join(" "),
              scopes: after,
              refreshTokenExpiresAt:
                token.refresh_token_expires_in === undefined
                  ? previous.refreshTokenExpiresAt
                  : new Date(now() + Number(token.refresh_token_expires_in) * 1000).toISOString(),
            };
            const capabilityIds =
              providerId === "gitlab" &&
              !after.some((scope) => scope === "read_api" || scope === "api")
                ? []
                : marked.meta!.linkCapabilityIds;
            const updated: Credential = {
              ...marked,
              secret: JSON.stringify(next),
              meta: {
                ...marked.meta,
                linkOAuthState: "connected",
                linkCapabilityIds: capabilityIds,
                lastRefreshAt: new Date(now()).toISOString(),
              },
            };
            if (!store.compareAndSwap(layer, input.id, marked, updated))
              throw new LocalOAuthLinkError("changed");
          } catch (error) {
            store.compareAndSwap(layer, input.id, marked, {
              ...marked,
              meta: { ...marked.meta, linkOAuthState: "reconnect" },
            });
            if (error instanceof LocalOAuthLinkError) throw error;
            throw new LocalOAuthLinkError("reconnect");
          }
        })
        .finally(() => {
          if (receipt) receipt.pending = undefined;
        });
      receipt = { identity, pending };
      refreshes.set(key, receipt);
    }
    await pending;
    options.signal?.throwIfAborted();
    current = read();
    assertAllowed(current);
    secret = parse(current);
    if (
      current.meta?.linkOAuthState === "refreshing" ||
      isOAuthAccessTokenExpired(secret, { now: now(), skewMs: 0 })
    )
      throw new LocalOAuthLinkError("reconnect");
  };
  options.signal?.throwIfAborted();
  if (
    isOAuthAccessTokenExpired(secret, { now: now() }) ||
    current.meta?.linkOAuthState === "refreshing"
  )
    await refresh();
  const authority = (credential: Credential) =>
    JSON.stringify([
      credential.meta?.linkProvider,
      credential.meta?.linkAccountId,
      credential.meta?.linkLastVerifiedAt,
      credential.meta?.linkCapabilityIds,
      credential.meta?.linkResourceGroups,
      parse(credential).clientId,
      parse(credential).scope,
    ]);
  let originalAuthority = authority(current);
  const execute = () =>
    action.execute({
      token: secret.accessToken,
      authKind: "oauth",
      params: input.params,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
  let result: unknown;
  try {
    result = await execute();
  } catch (error) {
    if (!(error instanceof LinkProviderHttpError) || error.status !== 401) throw error;
    if (action.risk === "write") {
      store.compareAndSwap(layer, input.id, current, {
        ...current,
        meta: { ...current.meta, linkOAuthState: "reconnect" },
      });
      throw new LocalOAuthLinkError("reconnect");
    }
    await refresh(secret.accessToken);
    originalAuthority = authority(current);
    try {
      result = await execute();
    } catch (retryError) {
      if (retryError instanceof LinkProviderHttpError && retryError.status === 401) {
        store.compareAndSwap(layer, input.id, current, {
          ...current,
          meta: { ...current.meta, linkOAuthState: "reconnect" },
        });
        throw new LocalOAuthLinkError("reconnect");
      }
      throw retryError;
    }
  }
  const latest = read();
  assertAllowed(latest);
  if (authority(latest) !== originalAuthority || latest.meta?.linkOAuthState === "refreshing")
    throw new LocalOAuthLinkError("changed");
  options.signal?.throwIfAborted();
  return result;
}
