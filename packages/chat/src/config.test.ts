import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGatewayConfig } from "./config.js";
import { FileWechatCredentialStore } from "./wechat-storage.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadGatewayConfig", () => {
  test("loads Telegram secrets and allowlists from env without a config file", () => {
    const home = tempRoot();
    const config = loadGatewayConfig({
      env: {
        HOME: home,
        CODE_SHELL_TELEGRAM_BOT_TOKEN: "bot-secret",
        CODE_SHELL_TELEGRAM_ALLOWED_CHAT_IDS: "100, 200,100",
        CODE_SHELL_TELEGRAM_ALLOWED_USER_IDS: "300",
      },
      platform: "darwin",
    });

    expect(config.channels).toHaveLength(1);
    expect(config.channels[0]?.channel).toBe("telegram");
    expect(config.channels[0]?.allowedTargetIds).toEqual(["100", "200"]);
    expect(config.channels[0]?.allowedUserIds).toEqual(["300"]);
    expect(config.desktop.command).toBe("/usr/bin/open");
    expect(config.desktop.descriptorPath).toBe(
      join(home, ".code-shell", "im-gateway", "desktop-control.json"),
    );
  });

  test("rejects a world-readable config because it controls secrets and launch commands", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const file = join(root, "config.json");
    writeFileSync(
      file,
      JSON.stringify({ telegram: { botToken: "secret", allowedChatIds: ["1"] } }),
      { mode: 0o644 },
    );
    chmodSync(file, 0o644);
    expect(() => loadGatewayConfig({ configPath: file, env: {}, platform: "linux" })).toThrow(
      "0600",
    );
  });

  test("custom desktop command does not inherit macOS open arguments", () => {
    const root = tempRoot();
    const file = join(root, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        telegram: { allowedChatIds: ["1"] },
        desktop: { command: "/opt/codeshell" },
      }),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(file, 0o600);
    const config = loadGatewayConfig({
      configPath: file,
      env: { CODE_SHELL_TELEGRAM_BOT_TOKEN: "secret" },
      platform: "darwin",
    });
    expect(config.desktop.args).toEqual([]);
  });

  test("loads multiple adapters and keeps each allowlist isolated", () => {
    const root = tempRoot();
    const file = join(root, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        discord: { botToken: "discord-secret", allowedChannelIds: ["discord-channel"] },
        matrix: {
          homeserverUrl: "https://matrix.example/",
          accessToken: "matrix-secret",
          allowedRoomIds: ["!room:example"],
        },
      }),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(file, 0o600);
    const config = loadGatewayConfig({ configPath: file, env: {}, platform: "linux" });

    expect(config.channels.map(({ channel }) => channel)).toEqual(["discord", "matrix"]);
    expect(config.channels[0]?.allowedTargetIds).toEqual(["discord-channel"]);
    expect(config.channels[1]?.allowedTargetIds).toEqual(["!room:example"]);
  });

  test("loads a QR-authenticated personal WeChat account without putting its token in config", () => {
    const root = tempRoot();
    const credentialsDir = join(root, "wechat-credentials");
    const store = new FileWechatCredentialStore(credentialsDir);
    const credentials = store.save({
      accountId: "abc@im.bot",
      token: "wechat-secret",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "owner-user",
    });
    const file = join(root, "config.json");
    writeFileSync(
      file,
      JSON.stringify({ wechat: { accountId: credentials.accountId, credentialsDir } }),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(file, 0o600);

    const config = loadGatewayConfig({ configPath: file, env: {}, platform: "linux" });

    expect(config.channels).toHaveLength(1);
    expect(config.channels[0]).toMatchObject({
      channel: "wechat",
      accountId: "abc-im-bot",
      token: "wechat-secret",
      allowedTargetIds: ["owner-user"],
      allowedUserIds: ["owner-user"],
    });
    if (process.platform !== "win32") {
      expect(statSync(store.credentialPath(credentials.accountId)).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects a partially configured adapter", () => {
    const root = tempRoot();
    expect(() =>
      loadGatewayConfig({
        env: { HOME: root, CODE_SHELL_SLACK_APP_TOKEN: "xapp-secret" },
        platform: "linux",
      }),
    ).toThrow("缺少 botToken");
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-config-"));
  roots.push(root);
  return root;
}
