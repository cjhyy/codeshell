import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginCodeShellWechat } from "./wechat-login.js";

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
});
