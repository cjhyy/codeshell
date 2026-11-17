import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { TrustedDeviceStore } from "./trusted-device-store.js";

export const ACCOUNT_RELAY_COOKIE = "__Host-cs_host_access";
const MAX_LOCAL_GRANT_MS = 10 * 60_000;
const DIRECTORY_CLOCK_SKEW_MS = 30_000;

export function hasAccountRelayCookie(request: IncomingMessage): boolean {
  return (request.headers.cookie ?? "")
    .split(";")
    .some((part) => part.trim().startsWith(`${ACCOUNT_RELAY_COOKIE}=`));
}

function requestToken(request: IncomingMessage): string | undefined {
  const cookies = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${ACCOUNT_RELAY_COOKIE}=`));
  const cookie =
    cookies.length === 1 ? cookies[0]!.slice(ACCOUNT_RELAY_COOKIE.length + 1) : undefined;
  const header = request.headers["x-codeshell-host-access"];
  if (cookies.length > 1 || (header !== undefined && cookie !== undefined && header !== cookie))
    return;
  const token = header ?? cookie;
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export interface AccountRelayBinding {
  authorizationKind: "passkey-remote";
  sourceKind: "browser" | "device";
  sourceHostId?: string;
  authorizationId: string;
  accountId: string;
  rootSessionId: string;
  hostId: string;
  environmentId: string;
  leaseId: string;
  expiresAt: number;
}

export interface AccountRelayProject {
  id: string;
  name: string;
  path: string;
}

/** Main owns device credentials and redeems only against its configured directory. */
export interface AccountRelayAccessProvider {
  hostId: string;
  environmentId: string;
  accountId?: string;
  accountOrigin?: string;
  redeem: (handoff: string) => Promise<AccountRelayBinding>;
  listProjects: () => Promise<AccountRelayProject[]>;
}

interface AccountPrincipal {
  provider: AccountRelayAccessProvider;
  key: string;
  deviceId: string;
  secretHash: string;
  expiresAt: number;
  tokens: Set<string>;
}

interface AccountAccess {
  principal: AccountPrincipal;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface CapturedAccountRelayAccess {
  deviceId: string;
  isAuthorized: () => boolean;
  /** Existing owner-scoped capabilities follow fresh grants for the same UV authority. */
  isCapabilityAuthorized: () => boolean;
}

/** Independent entrance gate; an account credential is never a Host credential. */
export class AccountRelayAccessGate {
  private provider?: AccountRelayAccessProvider;
  private readonly grants = new Map<string, AccountAccess>();
  private readonly principals = new Map<string, AccountPrincipal>();
  private readonly consumed = new Map<string, number>();
  private readonly pending = new Set<string>();
  private generation = 0;

  constructor(
    private readonly devices: TrustedDeviceStore,
    private readonly onRevoke: (deviceId: string) => void,
  ) {}

  setProvider(provider?: AccountRelayAccessProvider): void {
    this.clear();
    this.provider = provider;
  }

  get available(): boolean {
    return !!this.provider;
  }

  get accountEntryUrl(): string | undefined {
    try {
      const origin = this.provider?.accountOrigin;
      if (origin && new URL(origin).origin === origin && origin.startsWith("https://"))
        return `${origin}/app`;
    } catch {
      /* An invalid provider address must never become browser navigation. */
    }
    return;
  }

  clear(): void {
    this.generation++;
    for (const principal of this.principals.values()) this.retirePrincipal(principal);
    this.consumed.clear();
    this.pending.clear();
  }

  revokeDevice(deviceId: string): boolean {
    let revoked = false;
    for (const principal of this.principals.values())
      if (principal.deviceId === deviceId) {
        this.retirePrincipal(principal);
        revoked = true;
      }
    return revoked;
  }

  private retire(token: string): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    clearTimeout(grant.timer);
    grant.principal.tokens.delete(token);
    if (
      ![...grant.principal.tokens].some(
        (key) => (this.grants.get(key)?.expiresAt ?? 0) > Date.now(),
      )
    )
      this.retirePrincipal(grant.principal);
  }

  private retirePrincipal(principal: AccountPrincipal): void {
    if (this.principals.get(principal.key) !== principal) return;
    this.principals.delete(principal.key);
    for (const token of principal.tokens) {
      const grant = this.grants.get(token);
      if (grant) clearTimeout(grant.timer);
      this.grants.delete(token);
    }
    principal.tokens.clear();
    this.devices.removeEphemeralDevice(principal.deviceId);
    this.onRevoke(principal.deviceId);
  }

  private principalCurrent(principal: AccountPrincipal): boolean {
    return (
      this.provider === principal.provider &&
      this.principals.get(principal.key) === principal &&
      principal.expiresAt > Date.now() &&
      this.devices.isEphemeralDevice(principal.deviceId)
    );
  }

  async exchange(handoff: string) {
    const provider = this.provider;
    const generation = this.generation;
    const digest = createHash("sha256").update(handoff).digest("hex");
    for (const [key, expiresAt] of this.consumed)
      if (expiresAt <= Date.now()) this.consumed.delete(key);
    if (
      !provider ||
      this.grants.size + this.pending.size >= 128 ||
      this.pending.has(digest) ||
      this.consumed.has(digest)
    )
      throw new Error("Account relay handoff is unavailable");
    this.pending.add(digest);
    try {
      const binding = await provider.redeem(handoff);
      const now = Date.now();
      if (
        this.provider !== provider ||
        this.generation !== generation ||
        !binding ||
        typeof binding !== "object" ||
        binding.authorizationKind !== "passkey-remote" ||
        !["browser", "device"].includes(binding.sourceKind) ||
        (binding.sourceKind === "device" &&
          (typeof binding.sourceHostId !== "string" ||
            !binding.sourceHostId ||
            binding.sourceHostId.length > 512 ||
            binding.sourceHostId.includes("\0"))) ||
        ![
          binding.authorizationId,
          binding.accountId,
          binding.rootSessionId,
          binding.hostId,
          binding.environmentId,
          binding.leaseId,
        ].every(
          (value) =>
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 512 &&
            !value.includes("\0"),
        ) ||
        binding.hostId !== provider.hostId ||
        binding.environmentId !== provider.environmentId ||
        (provider.accountId !== undefined && binding.accountId !== provider.accountId) ||
        !Number.isSafeInteger(binding.expiresAt) ||
        binding.expiresAt <= now ||
        binding.expiresAt > now + MAX_LOCAL_GRANT_MS + DIRECTORY_CLOCK_SKEW_MS
      )
        throw new Error("Account relay handoff target is invalid");
      // A slightly ahead directory clock must not reject a fresh handoff, but
      // local authority still lasts at most ten minutes from this redemption.
      const expiresAt = Math.min(binding.expiresAt, now + MAX_LOCAL_GRANT_MS);
      // Keep the replay fence through the original directory expiry, including
      // the small interval after the capped local grant has expired.
      this.consumed.set(digest, binding.expiresAt);
      // A fresh directory redemption may continue one logical UV authority.
      // Lease IDs intentionally rotate; all other authority identity fields must match.
      const key = JSON.stringify([
        binding.authorizationId,
        binding.accountId,
        binding.rootSessionId,
        binding.hostId,
        binding.environmentId,
        binding.sourceKind,
        binding.sourceHostId ?? null,
      ]);
      let principal = this.principals.get(key);
      if (
        principal &&
        (!this.principalCurrent(principal) ||
          !this.devices.renewEphemeralDevice(principal.deviceId, principal.secretHash, expiresAt))
      ) {
        this.retirePrincipal(principal);
        principal = undefined;
      }
      if (!principal) {
        const secretHash = randomBytes(32).toString("base64url");
        const device = this.devices.addEphemeralDevice({
          name: "Account device session",
          secretHash,
          expiresAt,
        });
        principal = {
          provider,
          key,
          deviceId: device.id,
          secretHash,
          expiresAt,
          tokens: new Set(),
        };
        this.principals.set(key, principal);
      } else {
        principal.expiresAt = Math.max(principal.expiresAt, expiresAt);
      }
      const hostAccessToken = randomBytes(32).toString("base64url");
      const timer = setTimeout(() => this.retire(hostAccessToken), expiresAt - now);
      timer.unref();
      principal.tokens.add(hostAccessToken);
      this.grants.set(hostAccessToken, {
        principal,
        expiresAt,
        timer,
      });
      return {
        hostAccessToken,
        deviceId: principal.deviceId,
        secretHash: principal.secretHash,
        expiresAt,
        hostId: binding.hostId,
        environmentId: binding.environmentId,
      };
    } finally {
      // A retired generation cannot release a newer redemption of the same handoff.
      if (this.generation === generation) this.pending.delete(digest);
    }
  }

  capture(request: IncomingMessage): CapturedAccountRelayAccess | undefined {
    const token = requestToken(request);
    if (!token) return;
    const grant = this.grants.get(token);
    if (!grant) return;
    const isAuthorized = () =>
      this.principalCurrent(grant.principal) &&
      this.grants.get(token) === grant &&
      grant.expiresAt > Date.now();
    if (!isAuthorized()) {
      if (!this.principalCurrent(grant.principal)) this.retirePrincipal(grant.principal);
      else this.retire(token);
      return;
    }
    return {
      deviceId: grant.principal.deviceId,
      isAuthorized,
      isCapabilityAuthorized: () => this.principalCurrent(grant.principal),
    };
  }

  /** A browser restores only this short-lived identity, never a durable pairing. */
  browserCredential(request: IncomingMessage) {
    if (!hasAccountRelayCookie(request)) return;
    const access = this.capture(request);
    const token = requestToken(request);
    const grant = token && this.grants.get(token);
    if (!access || !grant || !access.isAuthorized()) return;
    return {
      deviceId: grant.principal.deviceId,
      secretHash: grant.principal.secretHash,
      expiresAt: grant.expiresAt,
      hostId: grant.principal.provider.hostId,
      environmentId: grant.principal.provider.environmentId,
      accountEntryUrl: this.accountEntryUrl,
    };
  }

  revokeRequest(request: IncomingMessage): void {
    const token = requestToken(request);
    if (token && this.capture(request)) this.retirePrincipal(this.grants.get(token)!.principal);
  }

  async projects(access: CapturedAccountRelayAccess) {
    const provider = this.provider;
    if (!provider || !access.isAuthorized()) throw new Error("Account relay access expired");
    const projects = await provider.listProjects();
    if (this.provider !== provider || !access.isAuthorized())
      throw new Error("Account relay access expired");
    return { hostId: provider.hostId, environmentId: provider.environmentId, projects };
  }
}

export async function readRelayHandoff(request: IncomingMessage): Promise<string> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json")
    throw new Error("Invalid relay handoff");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared > 8192) throw new Error("Invalid relay handoff");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timeout = setTimeout(() => request.destroy(), 10_000);
  timeout.unref();
  try {
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8192) throw new Error("Invalid relay handoff");
      chunks.push(Buffer.from(chunk));
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !("handoff" in input) ||
      typeof input.handoff !== "string" ||
      !/^[A-Za-z0-9_-]{32,4096}$/.test(input.handoff)
    )
      throw new Error("Invalid relay handoff");
    return input.handoff;
  } finally {
    clearTimeout(timeout);
  }
}
