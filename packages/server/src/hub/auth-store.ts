import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { acquireFileLock } from "@cjhyy/code-shell-core/internal";

export const HUB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_SESSIONS = 64;
const MAX_STORE_BYTES = 128 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface HubSession {
  id: string;
  username: string;
  deviceName: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface SessionRecord extends Omit<HubSession, "username"> {
  tokenHash: string;
}

interface AccountRecord {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: number;
}

interface AuthRecord {
  version: 1;
  bootstrapTokenHash: string | null;
  account: AccountRecord | null;
  sessions: SessionRecord[];
}

export interface HubLoginInput {
  username: string;
  password: string;
  deviceName?: string;
}

export interface HubSessionGrant {
  token: string;
  session: HubSession;
  revokedSessionIds: string[];
}

export class HubAuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class HubAuthStore {
  readonly filePath: string;
  readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly maxSessions: number;

  constructor(options: {
    dataDir: string;
    now?: () => number;
    sessionTtlMs?: number;
    maxSessions?: number;
  }) {
    this.filePath = join(options.dataDir, "hub", "auth.json");
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? HUB_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 1_000) {
      throw new Error("Hub session lifetime must be at least 1,000 milliseconds");
    }
    if (
      !Number.isSafeInteger(this.maxSessions) ||
      this.maxSessions < 1 ||
      this.maxSessions > MAX_SESSIONS
    ) {
      throw new Error(`Hub session limit must be between 1 and ${MAX_SESSIONS}`);
    }
  }

  /** Only the process that creates the store receives the one-time secret. */
  initialize(): string | undefined {
    this.ensureDirectory();
    const release = acquireFileLock(this.filePath);
    try {
      const current = this.read(true);
      if (current) {
        chmodSync(this.filePath, 0o600);
        return undefined;
      }
      const token = randomToken();
      this.write({ version: 1, bootstrapTokenHash: hashToken(token), account: null, sessions: [] });
      return token;
    } finally {
      release();
    }
  }

  isInitialized(): boolean {
    return this.read()!.account !== null;
  }

  async setup(input: HubLoginInput & { token: string }): Promise<HubSessionGrant> {
    const normalized = validateLoginInput(input);
    this.checkBootstrap(this.read()!, input.token);
    const salt = randomBytes(16).toString("hex");
    // Never await with the synchronous cross-process lock held.
    const passwordHash = await hashPassword(input.password, salt);
    return this.mutate((record) => {
      this.checkBootstrap(record, input.token);
      record.account = {
        username: normalized.username,
        passwordHash,
        passwordSalt: salt,
        createdAt: this.now(),
      };
      record.bootstrapTokenHash = null;
      return { result: this.grant(record, normalized.deviceName), changed: true };
    });
  }

  async login(input: HubLoginInput, replaceToken?: string): Promise<HubSessionGrant> {
    const normalized = validateLoginInput(input);
    const account = this.read()!.account;
    if (!account) throw new HubAuthError(401, "Invalid username or password");
    const candidate = await hashPassword(input.password, account.passwordSalt);
    if (
      !safeHashEqual(candidate, account.passwordHash) ||
      normalized.username !== account.username
    ) {
      throw new HubAuthError(401, "Invalid username or password");
    }
    return this.mutate((record) => {
      if (!record.account || !safeHashEqual(record.account.passwordHash, account.passwordHash)) {
        throw new HubAuthError(401, "Invalid username or password");
      }
      return { result: this.grant(record, normalized.deviceName, replaceToken), changed: true };
    });
  }

  authenticate(token: string | undefined): HubSession | null {
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    return this.mutate((record) => {
      const now = this.now();
      const tokenHash = hashToken(token);
      const session = record.sessions.find((row) => safeHashEqual(row.tokenHash, tokenHash));
      if (!record.account || !session || session.expiresAt <= now || session.createdAt > now) {
        return { result: null, changed: false };
      }
      // Persist activity at most once per minute; validation always reads disk.
      const changed = now - session.lastSeenAt >= 60_000;
      if (changed) session.lastSeenAt = now;
      return { result: this.toPublic(record, session), changed };
    });
  }

  listSessions(): HubSession[] {
    const record = this.read()!;
    const now = this.now();
    return record.sessions
      .filter((session) => session.expiresAt > now && session.createdAt <= now)
      .map((session) => this.toPublic(record, session))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  revoke(id: string): boolean {
    return this.mutate((record) => {
      const index = record.sessions.findIndex((session) => session.id === id);
      if (index < 0) return { result: false, changed: false };
      record.sessions.splice(index, 1);
      return { result: true, changed: true };
    });
  }

  private checkBootstrap(record: AuthRecord, token: string): void {
    if (record.account) throw new HubAuthError(409, "Hub has already been initialized");
    if (
      typeof token !== "string" ||
      !TOKEN_PATTERN.test(token) ||
      !safeHashEqual(hashToken(token), record.bootstrapTokenHash!)
    ) {
      throw new HubAuthError(401, "Invalid initialization token");
    }
  }

  private grant(record: AuthRecord, deviceName: string, replaceToken?: string): HubSessionGrant {
    const now = this.now();
    const replacedHash =
      replaceToken && TOKEN_PATTERN.test(replaceToken) ? hashToken(replaceToken) : null;
    const revokedSessionIds: string[] = [];
    record.sessions = record.sessions.filter((row) => {
      const remove =
        row.expiresAt <= now ||
        (replacedHash !== null && safeHashEqual(row.tokenHash, replacedHash));
      if (remove) revokedSessionIds.push(row.id);
      return !remove;
    });
    if (record.sessions.length >= this.maxSessions) {
      record.sessions.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
      revokedSessionIds.push(record.sessions.shift()!.id);
    }
    const token = randomToken();
    const session: SessionRecord = {
      id: randomUUID(),
      deviceName,
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    record.sessions.push(session);
    return { token, session: this.toPublic(record, session), revokedSessionIds };
  }

  private toPublic(record: AuthRecord, session: SessionRecord): HubSession {
    return {
      id: session.id,
      username: record.account!.username,
      deviceName: session.deviceName,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
    };
  }

  private mutate<R>(mutation: (record: AuthRecord) => { result: R; changed: boolean }): R {
    this.ensureDirectory();
    const release = acquireFileLock(this.filePath);
    try {
      const record = this.read()!;
      const { result, changed } = mutation(record);
      if (changed) this.write(record);
      return result;
    } finally {
      release();
    }
  }

  private ensureDirectory(): void {
    const parent = dirname(this.filePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Invalid Hub auth directory");
    chmodSync(parent, 0o700);
  }

  private read(allowMissing = false): AuthRecord | undefined {
    let descriptor: number | undefined;
    try {
      const metadata = lstatSync(this.filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STORE_BYTES) {
        throw new Error("Invalid Hub auth file");
      }
      descriptor = openSync(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size > MAX_STORE_BYTES)
        throw new Error("Invalid Hub auth file");
      const record: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
      if (!isAuthRecord(record)) throw new Error("Invalid Hub auth record");
      return record;
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // A malformed or missing established store must never reopen bootstrap.
      throw new Error("Hub authentication store is unavailable or corrupt", { cause: error });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private write(record: AuthRecord): void {
    const serialized = JSON.stringify(record, null, 2);
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES)
      throw new Error("Hub auth store limit exceeded");
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temp, this.filePath);
    } finally {
      rmSync(temp, { force: true });
    }
  }
}

function validateLoginInput(input: HubLoginInput): { username: string; deviceName: string } {
  if (
    !isLabel(input.username, 64) ||
    typeof input.password !== "string" ||
    input.password.length < 12 ||
    input.password.length > 256
  ) {
    throw new HubAuthError(
      400,
      "Use a username of 1–64 characters and a password of 12–256 characters",
    );
  }
  if (input.deviceName !== undefined && !isLabel(input.deviceName, 100)) {
    throw new HubAuthError(400, "Device name must contain 1–100 characters");
  }
  return { username: input.username.trim(), deviceName: input.deviceName?.trim() ?? "Browser" };
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(a: string, b: string): boolean {
  return (
    HASH_PATTERN.test(a) &&
    HASH_PATTERN.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  );
}

function hashPassword(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString("hex"));
    });
  });
}

function isLabel(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isAuthRecord(value: any): value is AuthRecord {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_SESSIONS
  )
    return false;
  if (value.account === null) {
    return (
      typeof value.bootstrapTokenHash === "string" &&
      HASH_PATTERN.test(value.bootstrapTokenHash) &&
      value.sessions.length === 0
    );
  }
  const account = value.account;
  if (
    !account ||
    value.bootstrapTokenHash !== null ||
    !isLabel(account.username, 64) ||
    !HASH_PATTERN.test(account.passwordHash) ||
    !/^[a-f0-9]{32}$/.test(account.passwordSalt) ||
    !isTimestamp(account.createdAt)
  )
    return false;
  const ids = new Set<string>();
  const hashes = new Set<string>();
  return value.sessions.every((session: any) => {
    if (
      !session ||
      !/^[a-f0-9-]{36}$/.test(session.id) ||
      !isLabel(session.deviceName, 100) ||
      !HASH_PATTERN.test(session.tokenHash) ||
      !isTimestamp(session.createdAt) ||
      !isTimestamp(session.lastSeenAt) ||
      !isTimestamp(session.expiresAt) ||
      session.expiresAt <= session.createdAt ||
      session.lastSeenAt < session.createdAt ||
      ids.has(session.id) ||
      hashes.has(session.tokenHash)
    )
      return false;
    ids.add(session.id);
    hashes.add(session.tokenHash);
    return true;
  });
}
