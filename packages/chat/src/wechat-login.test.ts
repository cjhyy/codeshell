import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginCodeShellWechat } from "./wechat-login.js";
import {
  FileWechatCredentialStore,
  FileWechatStateStore,
  wechatCredentialFingerprint,
  WechatStateOwnershipError,
} from "./wechat-storage.js";

describe("loginCodeShellWechat", () => {
  test("persists credentials and updates the owner-only gateway config", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-wechat-login-"));
    const configPath = join(root, "gateway", "config.json");
    const credentialsDir = join(root, "wechat");

    const result = await loginCodeShellWechat({
      configPath,
      credentialsDir,
      login: async () => ({
        connected: true,
        credentials: {
          accountId: "owner-account",
          token: "secret-token",
          baseUrl: "https://ilinkai.weixin.qq.com",
          userId: "owner-user",
        },
      }),
    });

    expect(result).toEqual({ accountId: "owner-account", configPath });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      wechat: { enabled: true, accountId: "owner-account", credentialsDir },
    });
    expect(JSON.parse(readFileSync(join(credentialsDir, "accounts.json"), "utf8"))).toEqual([
      "owner-account",
    ]);
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("resets credential-bound state when a QR rebind rotates the token", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-wechat-login-"));
    const credentialsDir = join(root, "wechat");
    const store = new FileWechatCredentialStore(credentialsDir);
    store.save({
      accountId: "owner-account",
      token: "old-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "owner-user",
    });
    await store.stateStore("owner-account").save({
      cursor: "old-cursor",
      contextTokens: { "owner-user": "old-context" },
    });

    await loginCodeShellWechat({
      configPath: join(root, "gateway.json"),
      credentialsDir,
      login: async () => ({
        connected: true,
        credentials: {
          accountId: "owner-account",
          token: "new-token",
          baseUrl: "https://ilinkai.weixin.qq.com",
          userId: "owner-user",
        },
      }),
    });

    await expect(store.stateStore("owner-account").load()).resolves.toEqual({});

    // A Gateway adapter still running with the revoked token must not be able
    // to write its stale cursor/context back over the fresh binding.
    const staleAdapterStore = new FileWechatStateStore(
      store.statePath("owner-account"),
      wechatCredentialFingerprint("old-token"),
    );
    await expect(
      staleAdapterStore.save({
        cursor: "old-cursor",
        contextTokens: { "owner-user": "old-context" },
      }),
    ).rejects.toThrow(WechatStateOwnershipError);
    await expect(store.stateStore("owner-account").load()).resolves.toEqual({});
  });

  test("preserves valid state but repairs malformed state after an explicit QR login", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-wechat-login-"));
    const credentialsDir = join(root, "wechat");
    const store = new FileWechatCredentialStore(credentialsDir);
    const credentials = {
      accountId: "owner-account",
      token: "same-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "owner-user",
    };
    store.save(credentials);
    await store.stateStore(credentials.accountId).save({
      cursor: "cursor-1",
      contextTokens: { "owner-user": "context-1" },
    });
    const login = async () => ({ connected: true as const, credentials });

    await loginCodeShellWechat({
      configPath: join(root, "gateway.json"),
      credentialsDir,
      login,
    });
    await expect(store.stateStore(credentials.accountId).load()).resolves.toEqual({
      cursor: "cursor-1",
      contextTokens: { "owner-user": "context-1" },
    });

    writeFileSync(store.statePath(credentials.accountId), "not-json", { mode: 0o600 });
    await loginCodeShellWechat({
      configPath: join(root, "gateway.json"),
      credentialsDir,
      login,
    });
    await expect(store.stateStore(credentials.accountId).load()).resolves.toEqual({});
  });

  test("repairs malformed state after an explicit already-connected confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-wechat-login-"));
    const credentialsDir = join(root, "wechat");
    const store = new FileWechatCredentialStore(credentialsDir);
    store.save({
      accountId: "owner-account",
      token: "same-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "owner-user",
    });
    writeFileSync(store.statePath("owner-account"), "not-json", { mode: 0o600 });

    await loginCodeShellWechat({
      configPath: join(root, "gateway.json"),
      credentialsDir,
      login: async () => ({ connected: false, alreadyConnected: true }),
    });

    await expect(store.stateStore("owner-account").load()).resolves.toEqual({});
  });
});
