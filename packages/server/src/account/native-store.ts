import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join, win32 } from "node:path";
import { homedir } from "node:os";
import { CloudAccountStore, validCloudAccountGrant, type SavedCloudAccount } from "./store.js";
import { isRelayOrigin } from "../remote-relay/protocol.js";

export type NativeAccountStoreRunner = (
  command: string,
  args: string[],
  input?: string,
) => { status: number | null; stdout: string; error?: unknown };
const execute: NativeAccountStoreRunner = (command, args, input) => {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 65_536,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "", error: result.error };
};
const unavailable = () =>
  new Error("系统安全存储不可用。可使用 --memory 保持当前进程内的账号会话；不会保存明文凭据。");
const validate = (saved: unknown, origin: string): saved is SavedCloudAccount =>
  isRelayOrigin(origin) &&
  validCloudAccountGrant(saved) &&
  saved.kind !== "device" &&
  (saved as SavedCloudAccount).origin === origin &&
  (saved.audience === undefined || saved.audience === origin);

/** Explicit temporary account authority; lifetime is the owning CLI session. */
export class MemoryAccountStore {
  private saved?: SavedCloudAccount;
  preflight() {}
  load() {
    return this.saved ? structuredClone(this.saved) : undefined;
  }
  save(value: SavedCloudAccount) {
    if (!validate(value, value.origin)) throw new Error("无效的账号授权。");
    this.saved = structuredClone(value);
  }
  forget() {
    this.saved = undefined;
  }
}

/** OS credential storage only. Secrets travel through pipes, never command arguments. */
export class NativeAccountStore {
  private readonly account: string;
  private readonly platform: NodeJS.Platform;
  private readonly run: NativeAccountStoreRunner;
  private readonly windows?: CloudAccountStore;
  constructor(
    private readonly origin: string,
    options: {
      platform?: NodeJS.Platform;
      run?: NativeAccountStoreRunner;
      dataDir?: string;
    } = {},
  ) {
    if (!isRelayOrigin(origin)) throw new Error("请输入完整的 HTTPS 账号服务地址。");
    this.account = createHash("sha256").update(origin).digest("hex");
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? execute;
    if (this.platform === "win32") {
      const crypt = (operation: "Protect" | "Unprotect", input: string) => {
        const script = `Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${operation}($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
        const result = this.run(
          win32.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          input,
        );
        if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.stdout))
          throw unavailable();
        return Buffer.from(result.stdout, "base64");
      };
      this.windows = new CloudAccountStore(
        join(options.dataDir ?? join(homedir(), ".code-shell", "accounts"), `${this.account}.enc`),
        {
          available: () => true,
          encrypt: (text) => crypt("Protect", Buffer.from(text).toString("base64")),
          decrypt: (bytes) => crypt("Unprotect", bytes.toString("base64")).toString("utf8"),
        },
      );
    }
  }
  private command(
    operation: "read" | "write" | "delete",
    account: string,
    value?: string,
  ): string | undefined {
    let result: ReturnType<NativeAccountStoreRunner>;
    if (this.platform === "darwin") {
      // security's interactive command parser receives only fixed identifiers + base64.
      // The process argument list contains no password, grant, or token.
      result =
        operation === "write"
          ? this.run(
              "/usr/bin/security",
              ["-i"],
              `add-generic-password -U -s codeshell-native-account -a ${account} -w ${value}\n`,
            )
          : this.run("/usr/bin/security", [
              operation === "read" ? "find-generic-password" : "delete-generic-password",
              "-s",
              "codeshell-native-account",
              "-a",
              account,
              ...(operation === "read" ? ["-w"] : []),
            ]);
    } else if (this.platform === "linux") {
      result = this.run(
        "/usr/bin/secret-tool",
        operation === "write"
          ? [
              "store",
              "--label=CodeShell Account",
              "service",
              "codeshell-native-account",
              "account",
              account,
            ]
          : [
              operation === "read" ? "lookup" : "clear",
              "service",
              "codeshell-native-account",
              "account",
              account,
            ],
        value,
      );
    } else throw unavailable();
    const missing = this.platform === "darwin" ? 44 : 1;
    if (!result.error && result.status === missing && operation !== "write") return;
    if (result.error || result.status !== 0) throw unavailable();
    return result.stdout.trim();
  }
  preflight() {
    if (this.windows) return this.windows.preflight();
    const account = `probe-${randomUUID()}`;
    const value = Buffer.from(randomUUID()).toString("base64");
    try {
      this.command("write", account, value);
      if (this.command("read", account) !== value) throw unavailable();
    } finally {
      this.command("delete", account);
    }
  }
  load(): SavedCloudAccount | undefined {
    const bytes = this.windows ? undefined : this.command("read", this.account);
    if (!this.windows && bytes === undefined) return;
    try {
      if (bytes && bytes.length > 32_768) throw unavailable();
      const saved = this.windows
        ? this.windows.load()
        : JSON.parse(Buffer.from(bytes!, "base64").toString("utf8"));
      if (saved === undefined && this.windows) return;
      if (!validate(saved, this.origin)) throw unavailable();
      return saved;
    } catch {
      throw new Error("账号安全存储读取失败，请退出后重新登录。");
    }
  }
  save(saved: SavedCloudAccount) {
    if (!validate(saved, this.origin)) throw new Error("无效的账号授权。");
    if (this.windows) return this.windows.save(saved);
    const encoded = Buffer.from(JSON.stringify(saved)).toString("base64");
    this.command("write", this.account, encoded);
    if (this.command("read", this.account) !== encoded) throw unavailable();
  }
  forget() {
    if (this.windows) return this.windows.forget();
    this.command("delete", this.account);
  }
}
