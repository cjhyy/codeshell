import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { TrustedDeviceStore } from "./trusted-device-store.js";

export interface AccountRelayBinding {
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
  redeem: (handoff: string) => Promise<AccountRelayBinding>;
  listProjects: () => Promise<AccountRelayProject[]>;
}

interface AccountAccess {
  provider: AccountRelayAccessProvider;
  deviceId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface CapturedAccountRelayAccess {
  deviceId: string;
  isAuthorized: () => boolean;
}

/** Independent entrance gate; an account credential is never a Host credential. */
export class AccountRelayAccessGate {
  private provider?: AccountRelayAccessProvider;
  private readonly grants = new Map<string, AccountAccess>();
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

  clear(): void {
    this.generation++;
    for (const token of this.grants.keys()) this.retire(token);
    this.consumed.clear();
    this.pending.clear();
  }

  revokeDevice(deviceId: string): boolean {
    let revoked = false;
    for (const [token, grant] of this.grants)
      if (grant.deviceId === deviceId) {
        this.retire(token);
        revoked = true;
      }
    return revoked;
  }

  private retire(token: string): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    clearTimeout(grant.timer);
    this.devices.removeEphemeralDevice(grant.deviceId);
    this.onRevoke(grant.deviceId);
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
        binding.expiresAt > now + 10 * 60_000
      )
        throw new Error("Account relay handoff target is invalid");
      this.consumed.set(digest, binding.expiresAt);
      const hostAccessToken = randomBytes(32).toString("base64url");
      const secretHash = randomBytes(32).toString("base64url");
      const device = this.devices.addEphemeralDevice({
        name: "Account device session",
        secretHash,
        expiresAt: binding.expiresAt,
      });
      const timer = setTimeout(() => this.retire(hostAccessToken), binding.expiresAt - now);
      timer.unref();
      this.grants.set(hostAccessToken, {
        provider,
        deviceId: device.id,
        expiresAt: binding.expiresAt,
        timer,
      });
      return {
        hostAccessToken,
        deviceId: device.id,
        secretHash,
        expiresAt: binding.expiresAt,
        hostId: binding.hostId,
        environmentId: binding.environmentId,
      };
    } finally {
      // A retired generation cannot release a newer redemption of the same handoff.
      if (this.generation === generation) this.pending.delete(digest);
    }
  }

  capture(request: IncomingMessage): CapturedAccountRelayAccess | undefined {
    const token = request.headers["x-codeshell-host-access"];
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const grant = this.grants.get(token);
    if (!grant) return;
    const isAuthorized = () =>
      this.provider === grant.provider &&
      this.grants.get(token) === grant &&
      this.devices.isEphemeralDevice(grant.deviceId) &&
      grant.expiresAt > Date.now();
    if (!isAuthorized()) {
      this.retire(token);
      return;
    }
    return { deviceId: grant.deviceId, isAuthorized };
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
