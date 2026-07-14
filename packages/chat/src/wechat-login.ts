import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  if (result.connected && result.credentials) {
    credentials = store.save(result.credentials);
  } else if (result.alreadyConnected) {
    credentials = store.load();
    if (!credentials) {
      throw new Error("微信端已绑定，但本机没有可用凭据；请在微信中先解除后重新登录");
    }
  } else {
    throw new Error("个人微信未完成连接");
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
  let raw: Record<string, unknown> = {};
  if (existsSync(options.configPath)) {
    if (process.platform !== "win32" && (statSync(options.configPath).mode & 0o077) !== 0) {
      throw new Error(`Chat gateway 配置权限必须为 0600：${options.configPath}`);
    }
    const parsed = JSON.parse(readFileSync(options.configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Chat gateway 配置不是 JSON object：${options.configPath}`);
    }
    raw = parsed as Record<string, unknown>;
  }
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
  mkdirSync(dirname(options.configPath), { recursive: true, mode: 0o700 });
  const temporary = `${options.configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, options.configPath);
  if (process.platform !== "win32") chmodSync(options.configPath, 0o600);
}
