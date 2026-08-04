import { randomUUID } from "node:crypto";
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

const MAX_WECHAT_STORE_BYTES = 1024 * 1024;

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
    const value = readJson(this.filePath, true);
    const parsed = parseWechatAdapterState(value);
    if (value !== undefined && !parsed) {
      throw new Error(`微信状态文件格式无效：${this.filePath}`);
    }
    return parsed;
  }

  async save(state: WechatAdapterState): Promise<void> {
    writeOwnerOnlyJson(this.filePath, state);
  }
}

/**
 * Synchronous readiness probe for hosts that expose proactive destinations in
 * a status/catalog call. It deliberately shares the exact parser used by the
 * adapter instead of letting each host reinterpret the state-file schema.
 */
export function hasWechatStoredContextToken(filePath: string, target: string): boolean {
  if (!target.trim()) return false;
  const state = parseWechatAdapterState(readJson(filePath));
  const token = state?.contextTokens?.[target];
  return typeof token === "string" && Boolean(token.trim());
}

function writeOwnerOnlyJson(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirInfo = lstatSync(dir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    throw new Error(`微信凭据或状态目录不是普通目录：${dir}`);
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_WECHAT_STORE_BYTES) {
    throw new Error("微信凭据或状态文件超过大小限制");
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    renameSync(temporary, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write/rename error.
    }
    throw error;
  }
}

function readJson(filePath: string, strict = false): unknown {
  let handle: number | undefined;
  try {
    const info = lstatSync(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`微信凭据或状态文件不是普通文件：${filePath}`);
    }
    if (info.size > MAX_WECHAT_STORE_BYTES) {
      throw new Error(`微信凭据或状态文件超过大小限制：${filePath}`);
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`微信凭据或状态文件权限必须为 0600：${filePath}`);
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = openSync(filePath, constants.O_RDONLY | noFollow);
    const openedInfo = fstatSync(handle);
    if (!openedInfo.isFile() || openedInfo.size > MAX_WECHAT_STORE_BYTES) {
      throw new Error(`微信凭据或状态文件无效：${filePath}`);
    }
    if (process.platform !== "win32" && (openedInfo.mode & 0o077) !== 0) {
      throw new Error(`微信凭据或状态文件权限必须为 0600：${filePath}`);
    }
    const raw = readFileSync(handle, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_WECHAT_STORE_BYTES) {
      throw new Error(`微信凭据或状态文件超过大小限制：${filePath}`);
    }
    return JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (strict) {
      const detail = error instanceof Error ? `：${error.message}` : "";
      throw new Error(`无法安全读取微信状态文件：${filePath}${detail}`, {
        cause: error,
      });
    }
    return undefined;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function parseWechatAdapterState(value: unknown): WechatAdapterState | undefined {
  if (!isRecord(value)) return undefined;
  const contextTokens = isRecord(value.contextTokens)
    ? Object.fromEntries(
        Object.entries(value.contextTokens).filter(
          (entry): entry is [string, string] =>
            Boolean(entry[0].trim()) && typeof entry[1] === "string" && Boolean(entry[1].trim()),
        ),
      )
    : undefined;
  return {
    cursor: readString(value.cursor),
    ...(contextTokens ? { contextTokens } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
