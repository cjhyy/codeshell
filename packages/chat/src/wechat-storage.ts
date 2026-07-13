import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface WechatCredentials {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  savedAt?: string;
}

export interface WechatAdapterState {
  cursor?: string;
  contextTokens?: Record<string, string>;
}

export interface WechatStateStore {
  load(): Promise<WechatAdapterState | undefined>;
  save(state: WechatAdapterState): Promise<void>;
}

export function defaultWechatDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".code-shell", "chat", "wechat");
}

export function normalizeWechatAccountId(accountId: string): string {
  const normalized = accountId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("微信 accountId 无效");
  return normalized;
}

export class FileWechatCredentialStore {
  constructor(readonly directory = defaultWechatDataDirectory()) {}

  listAccountIds(): string[] {
    const value = readJson(join(this.directory, "accounts.json"));
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  }

  listTokens(): string[] {
    return this.listAccountIds()
      .map((accountId) => this.load(accountId)?.token)
      .filter((token): token is string => Boolean(token));
  }

  load(accountId?: string): WechatCredentials | undefined {
    const selected = accountId ? normalizeWechatAccountId(accountId) : this.listAccountIds().at(-1);
    if (!selected) return undefined;
    const value = readJson(this.credentialPath(selected));
    if (!isRecord(value)) return undefined;
    const token = readString(value.token);
    const storedAccountId = readString(value.accountId) ?? selected;
    const baseUrl = readString(value.baseUrl);
    if (!token || !baseUrl) return undefined;
    return {
      accountId: storedAccountId,
      token,
      baseUrl,
      userId: readString(value.userId),
      savedAt: readString(value.savedAt),
    };
  }

  save(credentials: WechatCredentials): WechatCredentials {
    const normalizedId = normalizeWechatAccountId(credentials.accountId);
    const value: WechatCredentials = {
      ...credentials,
      accountId: normalizedId,
      savedAt: new Date().toISOString(),
    };
    writeOwnerOnlyJson(this.credentialPath(normalizedId), value);
    const accountIds = this.listAccountIds().filter((id) => id !== normalizedId);
    writeOwnerOnlyJson(join(this.directory, "accounts.json"), [...accountIds, normalizedId]);
    return value;
  }

  stateStore(accountId: string): FileWechatStateStore {
    return new FileWechatStateStore(this.statePath(accountId));
  }

  credentialPath(accountId: string): string {
    return join(this.directory, "accounts", `${normalizeWechatAccountId(accountId)}.json`);
  }

  statePath(accountId: string): string {
    return join(this.directory, "accounts", `${normalizeWechatAccountId(accountId)}.state.json`);
  }
}

export class FileWechatStateStore implements WechatStateStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<WechatAdapterState | undefined> {
    const value = readJson(this.filePath);
    if (!isRecord(value)) return undefined;
    const contextTokens = isRecord(value.contextTokens)
      ? Object.fromEntries(
          Object.entries(value.contextTokens).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
    return {
      cursor: readString(value.cursor),
      ...(contextTokens ? { contextTokens } : {}),
    };
  }

  async save(state: WechatAdapterState): Promise<void> {
    writeOwnerOnlyJson(this.filePath, state);
  }
}

function writeOwnerOnlyJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(filePath), 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

function readJson(filePath: string): unknown {
  try {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
