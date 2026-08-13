import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { defaultGatewayConfigPath } from "./config.js";
import {
  loginWechatWithQr,
  type WechatQrLoginOptions,
  type WechatQrLoginResult,
} from "./wechat.js";
import {
  defaultWechatDataDirectory,
  FileWechatCredentialStore,
  wechatCredentialFingerprint,
  type WechatCredentials,
} from "./wechat-storage.js";

export interface CodeShellWechatLoginOptions {
  configPath?: string;
  credentialsDir?: string;
  signal?: AbortSignal;
  onQrCode?: WechatQrLoginOptions["onQrCode"];
  onStatus?: WechatQrLoginOptions["onStatus"];
  requestVerificationCode?: WechatQrLoginOptions["requestVerificationCode"];
  /** Test/integration seam; normal callers use Tencent's QR login implementation. */
  login?: (options: WechatQrLoginOptions) => Promise<WechatQrLoginResult>;
}

export interface CodeShellWechatLoginResult {
  accountId: string;
  configPath: string;
}

const MAX_GATEWAY_CONFIG_BYTES = 4 * 1024 * 1024;

/**
 * Complete the personal-WeChat QR flow and persist both the owner-only token
 * and the matching CodeShell gateway configuration. Shared by the CLI and the
 * Desktop Link page so both entry points produce exactly the same files.
 */
export async function loginCodeShellWechat(
  options: CodeShellWechatLoginOptions = {},
): Promise<CodeShellWechatLoginResult> {
  const configPath = resolve(options.configPath ?? defaultGatewayConfigPath());
  const credentialsDir = resolve(options.credentialsDir ?? defaultWechatDataDirectory());
  // Validate the destination before starting a remote login or mutating local
  // credentials/state. A linked, oversized, malformed, or insecure config must
  // not leave a half-applied successful QR login behind.
  readGatewayConfigObject(configPath);
  const store = new FileWechatCredentialStore(credentialsDir);
  const login = options.login ?? loginWechatWithQr;
  const result = await login({
    signal: options.signal,
    localTokens: store.listTokens(),
    onQrCode: options.onQrCode,
    onStatus: options.onStatus,
    requestVerificationCode: options.requestVerificationCode,
  });

  let credentials: WechatCredentials | undefined;
  let credentialsChanged = false;
  if (result.connected && result.credentials) {
    const previous = store.load(result.credentials.accountId);
    credentials = store.save(result.credentials);
    credentialsChanged =
      !previous || previous.token !== credentials.token || previous.baseUrl !== credentials.baseUrl;
  } else if (result.alreadyConnected) {
    credentials = store.load();
    if (!credentials) {
      throw new Error("微信端已绑定，但本机没有可用凭据；请在微信中先解除后重新登录");
    }
  } else {
    throw new Error("个人微信未完成连接");
  }

  const stateStore = store.stateStore(
    credentials.accountId,
    wechatCredentialFingerprint(credentials.token),
  );
  if (credentialsChanged) {
    // Cursor and context tokens belong to the credential session that
    // produced them. Reusing them after a QR rebind can yield prepare failed
    // or poll from an unrelated cursor, so make the new binding start clean.
    // reset() stamps the new credential fingerprint, so an adapter still
    // running with the revoked token refuses to write its stale state back.
    await stateStore.reset({});
  } else {
    try {
      await stateStore.load();
    } catch {
      // Keep ordinary adapter startup fail-closed. An explicit successful
      // login (including an already-connected confirmation) is the recovery
      // boundary where replacing an unsafe state file is intentional.
      await stateStore.reset({});
    }
  }

  updateWechatConfig({
    configPath,
    credentials,
    credentialsDir: options.credentialsDir ? credentialsDir : undefined,
  });
  return { accountId: credentials.accountId, configPath };
}

function updateWechatConfig(options: {
  configPath: string;
  credentials: WechatCredentials;
  credentialsDir?: string;
}): void {
  const raw = readGatewayConfigObject(options.configPath);
  const existing =
    raw.wechat && typeof raw.wechat === "object" && !Array.isArray(raw.wechat)
      ? (raw.wechat as Record<string, unknown>)
      : {};
  const updated = {
    ...raw,
    wechat: {
      ...existing,
      enabled: true,
      accountId: options.credentials.accountId,
      ...(options.credentialsDir ? { credentialsDir: options.credentialsDir } : {}),
    },
  };
  const serialized = `${JSON.stringify(updated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_GATEWAY_CONFIG_BYTES) {
    throw new Error("Chat gateway 配置过大");
  }
  assertSafeConfigTarget(options.configPath);
  const temporary = `${options.configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
    renameSync(temporary, options.configPath);
    if (process.platform !== "win32") chmodSync(options.configPath, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readGatewayConfigObject(configPath: string): Record<string, unknown> {
  const parent = dirname(configPath);
  try {
    const parentInfo = lstatSync(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new Error("Chat gateway 配置目录必须是普通目录");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!existsSync(configPath)) {
    try {
      const linked = lstatSync(configPath);
      if (linked.isSymbolicLink()) throw new Error("linked config is not allowed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {};
  }
  let fd: number | undefined;
  try {
    const entry = lstatSync(configPath);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_GATEWAY_CONFIG_BYTES) {
      throw new Error(`Chat gateway 配置必须是有限大小的普通文件：${configPath}`);
    }
    if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) {
      throw new Error(`Chat gateway 配置权限必须为 0600：${configPath}`);
    }
    fd = openSync(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_GATEWAY_CONFIG_BYTES) {
      throw new Error(`Chat gateway 配置必须是有限大小的普通文件：${configPath}`);
    }
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Chat gateway 配置不是 JSON object：${configPath}`);
    }
    return parsed as Record<string, unknown>;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertSafeConfigTarget(configPath: string): void {
  const parent = dirname(configPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentInfo = lstatSync(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("Chat gateway 配置目录必须是普通目录");
  }
  try {
    const targetInfo = lstatSync(configPath);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      throw new Error("Chat gateway 配置必须是普通文件");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
