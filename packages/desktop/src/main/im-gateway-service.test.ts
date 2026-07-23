import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelMessageHandler } from "@cjhyy/code-shell-chat";
import { FileWechatCredentialStore } from "@cjhyy/code-shell-chat/wechat";
import { CredentialStore, type Credential, type EncryptionCipher } from "@cjhyy/code-shell-core";
import {
  createImGatewayActivityMiddleware,
  ImGatewayService,
  type ImGatewayActivity,
  type ImGatewayUiEvent,
} from "./im-gateway-service.js";

class MemoryCredentialStore {
  readonly credentials = new Map<string, Credential>();

  resolve(id: string): Credential | undefined {
    return this.credentials.get(id);
  }

  save(_scope: "user" | "project", credential: Credential): void {
    this.credentials.set(credential.id, credential);
  }
}

class TestCredentialCipher implements EncryptionCipher {
  encrypt(plaintext: string): string {
    return `enc:test:${Buffer.from(plaintext).toString("base64")}`;
  }

  decrypt(stored: string): string {
    return Buffer.from(stored.slice("enc:test:".length), "base64").toString("utf8");
  }

  canDecrypt(stored: string): boolean {
    return stored.startsWith("enc:test:");
  }
}

describe("ImGatewayService", () => {
  test("creates an owner-only editable config and reports missing channels", () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-service-"));
    const configPath = join(root, "nested", "config.json");
    const service = new ImGatewayService({ configPath });

    expect(service.status().configExists).toBe(false);
    expect(service.ensureConfig()).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);
    const template = JSON.parse(readFileSync(configPath, "utf8"));
    expect(template.telegram.enabled).toBe(false);
    expect(template.wechat.enabled).toBe(false);
    expect(service.status().channels).toEqual([]);
    expect(service.status().channelStatuses).toHaveLength(12);
    expect(service.status().channelStatuses.every(({ state }) => state === "disabled")).toBe(true);
    expect(service.status().recentActivity).toEqual([]);
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("reports configured channels without exposing their secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-status-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        telegram: {
          botToken: "secret-token",
          allowedChatIds: ["owner-chat"],
        },
      }),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(configPath, 0o600);

    const status = new ImGatewayService({ configPath }).status();
    expect(status.channels).toEqual(["telegram"]);
    expect(status.channelStatuses.find(({ channel }) => channel === "telegram")).toMatchObject({
      enabled: true,
      state: "ready",
      capabilities: {
        inbound: { attachments: ["image", "file", "audio", "video"] },
        outbound: { button: "native", attachments: ["image", "file"] },
      },
    });
    expect(status.channelStatuses.find(({ channel }) => channel === "wechat")).toMatchObject({
      enabled: false,
      state: "disabled",
      capabilities: {
        inbound: { attachments: ["image", "file", "audio", "video"] },
        outbound: { button: "link", attachments: ["image", "file"] },
      },
    });
    expect(status.error).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });

  test("reports a QR-connected personal WeChat account independently from DingTalk", () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-wechat-status-"));
    const configPath = join(root, "config.json");
    const credentialsDir = join(root, "wechat-credentials");
    const credentials = new FileWechatCredentialStore(credentialsDir).save({
      accountId: "wechat-account",
      token: "wechat-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "wechat-owner",
    });
    writeFileSync(
      configPath,
      JSON.stringify({
        wechat: {
          enabled: true,
          accountId: credentials.accountId,
          credentialsDir,
        },
        dingtalk: {
          enabled: false,
          clientId: "",
          allowedConversationIds: [],
          allowedUserIds: [],
        },
      }),
      { mode: 0o600 },
    );

    const status = new ImGatewayService({ configPath }).status();
    expect(status.channels).toEqual(["wechat"]);
    expect(status.channelStatuses.find(({ channel }) => channel === "wechat")).toMatchObject({
      enabled: true,
      state: "ready",
    });
    expect(status.channelStatuses.find(({ channel }) => channel === "dingtalk")).toMatchObject({
      enabled: false,
      state: "disabled",
    });
    expect(status.error).toBeUndefined();
  });

  test("marks enabled but incomplete channels without hiding the rest of the catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-invalid-status-"));
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ telegram: { enabled: true, botToken: "" } }), {
      mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(configPath, 0o600);

    const status = new ImGatewayService({ configPath }).status();
    expect(status.channels).toEqual([]);
    expect(status.channelStatuses).toHaveLength(12);
    expect(status.channelStatuses.find(({ channel }) => channel === "telegram")).toMatchObject({
      enabled: true,
      state: "needs-config",
    });
  });

  test("stores DingTalk secrets in the credential store and scrubs the gateway config", () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-dingtalk-"));
    const configPath = join(root, "config.json");
    const credentialDirectory = join(root, "credentials");
    const credentials = new CredentialStore(
      undefined,
      new TestCredentialCipher(),
      credentialDirectory,
    );
    const service = new ImGatewayService({ configPath, credentialStore: credentials });

    const setup = service.saveDingTalkSetup({
      enabled: true,
      clientId: "ding-client",
      clientSecret: "ding-secret",
      allowedConversationIds: [" cid-owner ", "cid-owner"],
      allowedUserIds: ["staff-owner"],
    });

    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.dingtalk).toEqual({
      enabled: true,
      clientId: "ding-client",
      allowedConversationIds: ["cid-owner"],
      allowedUserIds: ["staff-owner"],
    });
    expect(JSON.stringify(raw)).not.toContain("ding-secret");
    expect(credentials.resolve("im-gateway-dingtalk")?.secret).toContain("ding-secret");
    expect(readFileSync(join(credentialDirectory, "credentials.json"), "utf8")).not.toContain(
      "ding-secret",
    );
    expect(setup).toMatchObject({ hasClientSecret: true, secretStorage: "secure" });
    expect(service.status().channels).toEqual(["dingtalk"]);
    expect(JSON.stringify(service.status())).not.toContain("ding-secret");
  });

  test("migrates a legacy DingTalk secret when the structured form is saved", () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-dingtalk-legacy-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        dingtalk: {
          enabled: true,
          clientId: "legacy-client",
          clientSecret: "legacy-secret",
          allowedConversationIds: ["cid-legacy"],
          allowedUserIds: [],
        },
      }),
      { mode: 0o600 },
    );
    const credentials = new MemoryCredentialStore();
    const service = new ImGatewayService({ configPath, credentialStore: credentials });
    expect(service.getDingTalkSetup().secretStorage).toBe("legacy-config");

    service.saveDingTalkSetup({
      enabled: true,
      clientId: "legacy-client",
      allowedConversationIds: ["cid-legacy"],
      allowedUserIds: [],
    });

    expect(JSON.parse(readFileSync(configPath, "utf8")).dingtalk.clientSecret).toBeUndefined();
    expect(credentials.resolve("im-gateway-dingtalk")?.secret).toContain("legacy-secret");
    expect(service.getDingTalkSetup().secretStorage).toBe("secure");
  });

  test("discovers DingTalk conversations without dispatching them to the gateway", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-dingtalk-discovery-"));
    const configPath = join(root, "config.json");
    const credentials = new MemoryCredentialStore();
    const events: ImGatewayUiEvent[] = [];
    let handler: ChannelMessageHandler | undefined;
    const service = new ImGatewayService({
      configPath,
      credentialStore: credentials,
      emit: (event) => events.push(event),
      createDingTalkAdapter: (config) => ({
        channel: "dingtalk",
        run: async (next, signal) => {
          handler = next;
          config.onConnected?.();
          await new Promise<void>((resolveDone) => {
            signal.addEventListener("abort", () => resolveDone(), { once: true });
          });
        },
        send: async () => undefined,
      }),
    });
    service.saveDingTalkSetup({
      enabled: false,
      clientId: "discover-client",
      clientSecret: "discover-secret",
      allowedConversationIds: [],
      allowedUserIds: [],
    });

    const { discoveryId } = await service.startDingTalkDiscovery();
    if (!handler) throw new Error("discovery adapter did not receive a handler");
    await handler({
      channel: "dingtalk",
      target: "cid-discovered",
      senderId: "staff-discovered",
      text: "@机器人 测试连接",
      metadata: {
        conversationTitle: "发现测试群",
        conversationType: "2",
        senderName: "小明",
      },
    });

    expect(events).toContainEqual({
      type: "dingtalk-discovery-state",
      discoveryId,
      state: "listening",
    });
    expect(events).toContainEqual({
      type: "dingtalk-conversation-discovered",
      discoveryId,
      conversation: {
        conversationId: "cid-discovered",
        title: "发现测试群",
        conversationType: "2",
        users: [{ id: "staff-discovered", name: "小明" }],
        lastMessagePreview: "@机器人 测试连接",
        discoveredAt: expect.any(Number),
      },
    });
    expect(await service.stopDingTalkDiscovery()).toBe(true);
  });

  test("awaits the lazy channel factory before starting selected adapters", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-lazy-adapter-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        telegram: {
          botToken: "test-token",
          allowedChatIds: ["owner-chat"],
          allowedUserIds: [],
        },
        desktop: { autoLaunch: false },
        runtime: {
          lockPath: join(root, "gateway.lock"),
          inboxPath: join(root, "inbox.json"),
          eventCursorPath: join(root, "events.json"),
          adapterRestartBaseMs: 5,
          adapterRestartMaxMs: 5,
        },
      }),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(configPath, 0o600);
    const factoryCalls: string[] = [];
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (config) => {
        await Promise.resolve();
        factoryCalls.push(config.channel);
        return {
          channel: config.channel,
          run: async (_handler, signal) => {
            if (signal.aborted) return;
            await new Promise<void>((resolveDone) =>
              signal.addEventListener("abort", () => resolveDone(), { once: true }),
            );
          },
          send: async () => undefined,
        };
      },
    });

    try {
      const status = await service.start();
      expect(factoryCalls).toEqual(["telegram"]);
      expect(status).toMatchObject({ running: true, channels: ["telegram"] });
    } finally {
      await service.stop();
    }
  });

  test("starts configured channels automatically at Desktop launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-autostart-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        telegram: {
          botToken: "test-token",
          allowedChatIds: ["owner-chat"],
          allowedUserIds: [],
        },
        desktop: {
          autoLaunch: false,
          descriptorPath: join(root, "missing-desktop-control.json"),
        },
        runtime: {
          lockPath: join(root, "gateway.lock"),
          inboxPath: join(root, "inbox.json"),
          eventCursorPath: join(root, "events.json"),
          adapterRestartBaseMs: 5,
          adapterRestartMaxMs: 5,
        },
      }),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(configPath, 0o600);
    let factoryCalls = 0;
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (config) => {
        factoryCalls += 1;
        return {
          channel: config.channel,
          run: async (_handler, signal) => {
            if (signal.aborted) return;
            await new Promise<void>((resolveDone) =>
              signal.addEventListener("abort", () => resolveDone(), { once: true }),
            );
          },
          send: async () => undefined,
        };
      },
    });

    try {
      expect(await service.startConfiguredAtLaunch()).toMatchObject({
        running: true,
        channels: ["telegram"],
      });
      expect(await service.startConfiguredAtLaunch()).toMatchObject({ running: true });
      expect(factoryCalls).toBe(1);
    } finally {
      await service.dispose();
    }
  });

  test("keeps launch non-blocking when no channel is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-autostart-empty-"));
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ telegram: { enabled: false } }), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(configPath, 0o600);
    let factoryCalls = 0;
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async () => {
        factoryCalls += 1;
        throw new Error("disabled channels must not start");
      },
    });

    expect(await service.startConfiguredAtLaunch()).toMatchObject({
      running: false,
      channels: [],
    });
    expect(factoryCalls).toBe(0);
  });

  test("captures bounded message previews around replies", async () => {
    const activity: ImGatewayActivity[] = [];
    const sent: string[] = [];
    const middleware = createImGatewayActivityMiddleware((entry) => activity.push(entry));
    const context = {
      message: {
        channel: "telegram",
        target: "chat-1",
        senderId: "owner-1",
        text: `hello ${"x".repeat(400)}`,
        attachments: [
          {
            id: "image-1",
            kind: "image" as const,
            load: async () => new Uint8Array(),
          },
        ],
      },
      adapter: {
        channel: "telegram",
        run: async () => undefined,
        send: async (_target: string, message: { text: string }) => void sent.push(message.text),
      },
      reply: async (message: { text: string }) => void sent.push(message.text),
    };
    await middleware(context, async () => {
      await context.reply({ text: "done" });
    });

    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({
      channel: "telegram",
      direction: "inbound",
      status: "received",
      attachmentCount: 1,
    });
    expect(activity[0]!.text.length).toBe(280);
    expect(activity[1]).toMatchObject({ direction: "outbound", status: "sent", text: "done" });
    expect(activity[1]!.requestId).toBe(activity[0]!.requestId);
    expect(sent).toEqual(["done"]);
  });
});
