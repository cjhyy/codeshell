import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireGatewayInstanceLock,
  notificationDeliveryProgressPath,
  notificationTargetProgressKey,
  type ChannelMessageHandler,
} from "@cjhyy/code-shell-chat";
import { FileWechatCredentialStore } from "@cjhyy/code-shell-chat/wechat";
import { CredentialStore, type Credential, type EncryptionCipher } from "@cjhyy/code-shell-core";
import type { CronJobLifecycleEvent } from "@cjhyy/code-shell-core/internal";
import { automationLifecycleNotification } from "./automation-notification.js";
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
        outbound: {
          proactive: true,
          direct: true,
          button: "native",
          attachments: ["image", "file"],
        },
      },
    });
    expect(status.channelStatuses.find(({ channel }) => channel === "wechat")).toMatchObject({
      enabled: false,
      state: "disabled",
      capabilities: {
        inbound: { attachments: ["image", "file", "audio", "video"] },
        outbound: {
          proactive: true,
          direct: true,
          button: "link",
          attachments: ["image", "file"],
        },
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

  test("sends proactive owner messages only through opaque, currently allowlisted targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-owner-send-"));
    const configPath = join(root, "config.json");
    const config = {
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
    };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(configPath, 0o600);
    const sent: Array<{ target: string; text: string }> = [];
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (channel) => ({
        channel: channel.channel,
        run: async (_handler, signal) => {
          if (signal.aborted) return;
          await new Promise<void>((resolveDone) =>
            signal.addEventListener("abort", () => resolveDone(), { once: true }),
          );
        },
        send: async (target, message) => {
          sent.push({ target, text: message.text });
        },
      }),
    });

    try {
      await service.start();
      const targets = service.listOwnerMessageTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ channel: "telegram", label: "Telegram" });
      expect(JSON.stringify(targets)).not.toContain("owner-chat");

      await service.sendOwnerMessage(targets[0]!.id, "已经完成");
      expect(sent).toEqual([{ target: "owner-chat", text: "已经完成" }]);

      writeFileSync(
        configPath,
        JSON.stringify({
          ...config,
          telegram: { ...config.telegram, allowedChatIds: ["replacement-chat"] },
        }),
        { mode: 0o600 },
      );
      await expect(service.sendOwnerMessage(targets[0]!.id, "不应发送")).rejects.toThrow("未授权");
      expect(sent).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });

  test("exposes personal WeChat as an opaque direct Mimi destination while Gateway is stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-wechat-reply-only-"));
    const configPath = join(root, "config.json");
    const credentialsDir = join(root, "wechat-credentials");
    const credentialStore = new FileWechatCredentialStore(credentialsDir);
    const credentials = credentialStore.save({
      accountId: "wechat-account",
      token: "wechat-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "wechat-owner",
    });
    await credentialStore.stateStore(credentials.accountId).save({
      contextTokens: { "wechat-owner": "fresh-context" },
    });
    writeFileSync(
      configPath,
      JSON.stringify({
        wechat: {
          enabled: true,
          accountId: credentials.accountId,
          credentialsDir,
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
    const sent: Array<{
      text: string;
      attachments: Array<{ kind: string; name: string; bytes: number[] }>;
    }> = [];
    let releaseFirstSend!: () => void;
    const firstSendGate = new Promise<void>((resolveGate) => {
      releaseFirstSend = resolveGate;
    });
    let markFirstSendEntered!: () => void;
    const firstSendEntered = new Promise<void>((resolveEntered) => {
      markFirstSendEntered = resolveEntered;
    });
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (channel) => ({
        channel: channel.channel,
        run: async (_handler, signal) => {
          if (signal.aborted) return;
          await new Promise<void>((resolveDone) =>
            signal.addEventListener("abort", () => resolveDone(), { once: true }),
          );
        },
        send: async (_target, message) => {
          sent.push({
            text: message.text,
            attachments: (message.attachments ?? []).map((attachment) => ({
              kind: attachment.kind,
              name: attachment.name,
              bytes: [...attachment.data],
            })),
          });
          if (sent.length === 1) {
            markFirstSendEntered();
            await firstSendGate;
          }
        },
      }),
    });

    try {
      const targets = service.listOwnerMessageTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        channel: "wechat",
        label: "微信",
        attachments: ["image", "file", "audio", "video"],
        maxAttachments: 4,
        maxAttachmentBytes: 10 * 1024 * 1024,
      });
      expect(JSON.stringify(targets)).not.toContain("wechat-owner");

      const firstSend = service.sendOwnerMessage(targets[0]!.id, "可以直接发送", [
        {
          kind: "image",
          name: "result.png",
          mimeType: "image/png",
          data: Uint8Array.from([1, 2, 3]),
        },
      ]);
      await firstSendEntered;
      const secondSend = service.sendOwnerMessage(targets[0]!.id, "第二条直发");
      await Promise.resolve();
      expect(sent).toHaveLength(1);
      releaseFirstSend();
      await Promise.all([firstSend, secondSend]);
      expect(sent).toEqual([
        {
          text: "可以直接发送",
          attachments: [{ kind: "image", name: "result.png", bytes: [1, 2, 3] }],
        },
        { text: "第二条直发", attachments: [] },
      ]);
      await expect(
        service.sendOwnerMessage(targets[0]!.id, "不支持的附件", [
          {
            kind: "archive" as never,
            name: "result.zip",
            mimeType: "application/zip",
            data: Uint8Array.from([1]),
          },
        ]),
      ).rejects.toThrow("附件类型、数量或大小超出目标渠道能力");
      await expect(service.sendOwnerMessage(targets[0]!.id, "bad\u0000text")).rejects.toThrow(
        "控制字符",
      );
      await expect(
        service.sendOwnerMessage(targets[0]!.id, "附件名不安全", [
          {
            kind: "image",
            name: "../result.png",
            mimeType: "image/png",
            data: Uint8Array.from([1]),
          },
        ]),
      ).rejects.toThrow("附件类型、数量或大小超出目标渠道能力");
      await expect(service.sendOwnerMessage("forged-wechat-target", "不应发送")).rejects.toThrow(
        "未授权",
      );
      expect(sent).toHaveLength(2);
    } finally {
      await service.stop();
    }
  });

  test("direct-delivers a scheduled completion while stopped and hands off cleanly to start", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-direct-notification-"));
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
    const sent: Array<{ target: string; text: string }> = [];
    let releaseDirect!: () => void;
    const directGate = new Promise<void>((resolveGate) => {
      releaseDirect = resolveGate;
    });
    let markDirectEntered!: () => void;
    const directEntered = new Promise<void>((resolveEntered) => {
      markDirectEntered = resolveEntered;
    });
    let runCalls = 0;
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (channel) => ({
        channel: channel.channel,
        run: async (_handler, signal) => {
          runCalls += 1;
          if (signal.aborted) return;
          await new Promise<void>((resolveDone) =>
            signal.addEventListener("abort", () => resolveDone(), { once: true }),
          );
        },
        send: async (target, message) => {
          sent.push({ target, text: message.text });
          if (sent.length === 1) {
            markDirectEntered();
            await directGate;
          }
        },
      }),
    });
    const notification = automationLifecycleNotification({
      type: "job_end",
      durationMs: 1_400,
      job: {
        id: "job-1",
        name: "每日检查",
        schedule: "1d",
        prompt: "inspect",
        enabled: true,
        runCount: 1,
        createdAt: 1,
      },
    } satisfies CronJobLifecycleEvent);
    if (!notification) throw new Error("missing terminal automation notification");
    const event = {
      id: 1,
      createdAt: 1,
      ...notification,
      target: { channel: "telegram", target: "owner-chat" },
    };
    const context = { streamId: "d".repeat(32) };

    const direct = service.deliverPublishedNotification(event, context);
    await directEntered;
    const start = service.start();
    await Promise.resolve();
    expect(runCalls).toBe(0);
    releaseDirect();
    expect(await direct).toBe(true);
    expect(await start).toMatchObject({ running: true });
    expect(runCalls).toBe(1);
    expect(sent).toEqual([
      {
        target: "owner-chat",
        text: "定时任务「每日检查」已完成（用时 1 秒）。可在 CodeShell 中查看完整结果。",
      },
    ]);

    // The live event watcher is now the only delivery owner.
    expect(await service.deliverPublishedNotification({ ...event, id: 2 }, context)).toBe(false);
    expect(sent).toHaveLength(1);
    await service.stop();

    await expect(
      service.deliverPublishedNotification(
        { ...event, id: 3, target: { channel: "telegram", target: "attacker" } },
        context,
      ),
    ).rejects.toThrow("未授权");
    expect(sent).toHaveLength(1);
  });

  test("direct-delivers a semantic automation stop with its owner-readable reason", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-direct-stop-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        telegram: {
          botToken: "test-token",
          allowedChatIds: ["owner-chat"],
          allowedUserIds: [],
        },
        runtime: {
          lockPath: join(root, "gateway.lock"),
          inboxPath: join(root, "inbox.json"),
          eventCursorPath: join(root, "events.json"),
        },
      }),
      { mode: 0o600 },
    );
    const sent: Array<{ target: string; text: string }> = [];
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (channel) => ({
        channel: channel.channel,
        run: async () => undefined,
        send: async (target, message) => void sent.push({ target, text: message.text }),
      }),
    });
    const notification = automationLifecycleNotification({
      type: "job_stopped",
      durationMs: 800,
      reason: "续接目标会话已删除，请重新选择",
      job: {
        id: "job-1",
        name: "每日跟进",
        schedule: "1d",
        prompt: "follow up",
        enabled: false,
        runCount: 1,
        createdAt: 1,
      },
    } satisfies CronJobLifecycleEvent);
    if (!notification) throw new Error("missing stopped automation notification");

    await expect(
      service.deliverPublishedNotification(
        {
          id: 1,
          createdAt: 1,
          ...notification,
          target: { channel: "telegram", target: "owner-chat" },
        },
        { streamId: "f".repeat(32) },
      ),
    ).resolves.toBe(true);
    expect(sent).toEqual([
      {
        target: "owner-chat",
        text: "定时任务「每日跟进」已停止（用时 1 秒）：续接目标会话已删除，请重新选择",
      },
    ]);
  });

  test("keeps a partially direct-delivered event unacknowledged for the Gateway to finish", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-partial-direct-"));
    const configPath = join(root, "config.json");
    const eventCursorPath = join(root, "events.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        telegram: {
          botToken: "test-token",
          allowedChatIds: ["owner-chat"],
          allowedUserIds: [],
        },
        discord: {
          botToken: "discord-token",
          allowedChannelIds: ["owner-channel"],
          allowedUserIds: [],
        },
        notifications: {
          enabled: true,
          targets: { telegram: ["owner-chat"], discord: ["owner-channel"] },
        },
        runtime: {
          lockPath: join(root, "gateway.lock"),
          inboxPath: join(root, "inbox.json"),
          eventCursorPath,
        },
      }),
      { mode: 0o600 },
    );
    const sent: Array<{ channel: string; target: string; text: string }> = [];
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (channel) => ({
        channel: channel.channel,
        run: async () => undefined,
        send: async (target, message) =>
          void sent.push({ channel: channel.channel, target, text: message.text }),
      }),
    });
    const context = { streamId: "c".repeat(32) };

    // Discord is not direct-capable: telegram is sent now, but the event must
    // stay in the durable outbox (no ack) until the Gateway reaches discord.
    await expect(
      service.deliverPublishedNotification(
        { id: 1, createdAt: 1, type: "pet.task.completed", text: "完成" },
        context,
      ),
    ).resolves.toBe(false);
    expect(sent).toEqual([{ channel: "telegram", target: "owner-chat", text: "完成" }]);

    // The delivered telegram target is checkpointed so a resumed Gateway
    // watcher finishes discord without repeating telegram.
    const progress = JSON.parse(
      readFileSync(notificationDeliveryProgressPath(eventCursorPath), "utf8"),
    ) as { events: Record<string, { chunks: Record<string, number> }> };
    expect(
      progress.events[`${context.streamId}:1`]?.chunks[
        notificationTargetProgressKey("telegram", "owner-chat")
      ],
    ).toBe(1);
  });

  test("never opens a one-shot adapter while a separate CLI Gateway owns the lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-external-owner-"));
    const configPath = join(root, "config.json");
    const lockPath = join(root, "gateway.lock");
    writeFileSync(
      configPath,
      JSON.stringify({
        telegram: {
          botToken: "test-token",
          allowedChatIds: ["owner-chat"],
          allowedUserIds: [],
        },
        runtime: {
          lockPath,
          inboxPath: join(root, "inbox.json"),
          eventCursorPath: join(root, "events.json"),
        },
      }),
      { mode: 0o600 },
    );
    let factoryCalls = 0;
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (channel) => {
        factoryCalls += 1;
        return {
          channel: channel.channel,
          run: async () => undefined,
          send: async () => undefined,
        };
      },
    });
    const external = acquireGatewayInstanceLock(lockPath, "code-shell-chat CLI");
    try {
      expect(
        await service.deliverPublishedNotification(
          {
            id: 1,
            createdAt: 1,
            type: "pet.task.completed",
            text: "完成",
            target: { channel: "telegram", target: "owner-chat" },
          },
          { streamId: "e".repeat(32) },
        ),
      ).toBe(false);
      const target = service.listOwnerMessageTargets()[0];
      if (!target) throw new Error("missing owner target");
      await expect(service.sendOwnerMessage(target.id, "主动消息")).rejects.toThrow(
        "code-shell-chat CLI",
      );
      expect(factoryCalls).toBe(0);
    } finally {
      external.release();
    }
  });

  test("a proactive send arriving during Gateway construction waits for the live adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-start-send-handoff-"));
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
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolveGate) => {
      releaseFactory = resolveGate;
    });
    let markFactoryEntered!: () => void;
    const factoryEntered = new Promise<void>((resolveEntered) => {
      markFactoryEntered = resolveEntered;
    });
    let factoryCalls = 0;
    const sent: string[] = [];
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (channel) => {
        factoryCalls += 1;
        markFactoryEntered();
        await factoryGate;
        return {
          channel: channel.channel,
          run: async (_handler, signal) => {
            if (signal.aborted) return;
            await new Promise<void>((resolveDone) =>
              signal.addEventListener("abort", () => resolveDone(), { once: true }),
            );
          },
          send: async (_target, message) => void sent.push(message.text),
        };
      },
    });

    const starting = service.start();
    await factoryEntered;
    const target = service.listOwnerMessageTargets()[0];
    if (!target) throw new Error("missing owner target");
    const sending = service.sendOwnerMessage(target.id, "使用正在启动的连接");
    await Promise.resolve();
    expect(factoryCalls).toBe(1);
    expect(sent).toEqual([]);
    releaseFactory();
    await starting;
    await sending;
    expect(factoryCalls).toBe(1);
    expect(sent).toEqual(["使用正在启动的连接"]);
    await service.stop();
  });

  test("hides WeChat proactive targets until an inbound message provides context", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-wechat-context-"));
    const configPath = join(root, "config.json");
    const credentialsDir = join(root, "wechat-credentials");
    const credentialStore = new FileWechatCredentialStore(credentialsDir);
    const credentials = credentialStore.save({
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
      }),
      { mode: 0o600 },
    );
    const service = new ImGatewayService({ configPath });

    expect(service.listOwnerMessageTargets()).toEqual([]);
    expect(
      service.status().channelStatuses.find(({ channel }) => channel === "wechat"),
    ).toMatchObject({
      proactiveReady: false,
      proactiveReason: "awaiting-inbound-context",
    });
    await credentialStore.stateStore(credentials.accountId).save({
      contextTokens: { "wechat-owner": "fresh-context" },
    });
    expect(service.listOwnerMessageTargets()).toHaveLength(1);
    expect(
      service.status().channelStatuses.find(({ channel }) => channel === "wechat"),
    ).toMatchObject({ proactiveReady: true });
    await credentialStore.stateStore(credentials.accountId).save({ contextTokens: {} });
    expect(service.listOwnerMessageTargets()).toEqual([]);
  });

  test("removes a WeChat Mimi destination after a failed send invalidates its context", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-wechat-stale-context-"));
    const configPath = join(root, "config.json");
    const credentialsDir = join(root, "wechat-credentials");
    const credentialStore = new FileWechatCredentialStore(credentialsDir);
    const credentials = credentialStore.save({
      accountId: "wechat-account",
      token: "wechat-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "wechat-owner",
    });
    const stateStore = credentialStore.stateStore(credentials.accountId);
    await stateStore.save({ contextTokens: { "wechat-owner": "stale-context" } });
    writeFileSync(
      configPath,
      JSON.stringify({
        wechat: {
          enabled: true,
          accountId: credentials.accountId,
          credentialsDir,
        },
        runtime: {
          lockPath: join(root, "gateway.lock"),
          inboxPath: join(root, "inbox.json"),
          eventCursorPath: join(root, "events.json"),
        },
      }),
      { mode: 0o600 },
    );
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (channel) => ({
        channel: channel.channel,
        run: async () => undefined,
        send: async () => {
          // Mirrors WechatAdapter's stale-context eviction before it reports
          // that the tokenless compatibility attempt was also rejected.
          await stateStore.save({ contextTokens: {} });
          throw new Error("微信直接发送失败：prepare failed");
        },
      }),
    });

    const target = service.listOwnerMessageTargets()[0];
    if (!target) throw new Error("missing context-bound WeChat target");
    await expect(service.sendOwnerMessage(target.id, "测试消息")).rejects.toThrow("prepare failed");
    expect(service.listOwnerMessageTargets()).toEqual([]);
    expect(
      service.status().channelStatuses.find(({ channel }) => channel === "wechat"),
    ).toMatchObject({
      proactiveReady: false,
      proactiveReason: "awaiting-inbound-context",
    });
  });

  test("keeps lifecycle-bound channels unavailable to Mimi while Gateway is stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-lifecycle-bound-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        discord: {
          enabled: true,
          botToken: "discord-token",
          allowedChannelIds: ["owner-channel"],
          allowedUserIds: [],
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
    const service = new ImGatewayService({
      configPath,
      createChannelAdapter: async (channel) => ({
        channel: channel.channel,
        run: async (_handler, signal) => {
          if (signal.aborted) return;
          await new Promise<void>((resolveDone) =>
            signal.addEventListener("abort", () => resolveDone(), { once: true }),
          );
        },
        send: async () => undefined,
      }),
    });

    expect(service.listOwnerMessageTargets()).toEqual([]);
    try {
      await service.start();
      expect(service.listOwnerMessageTargets()).toHaveLength(1);
    } finally {
      await service.stop();
    }
    expect(service.listOwnerMessageTargets()).toEqual([]);
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
      await (context.reply as (message: Record<string, unknown>) => Promise<void>)({
        text: "done",
        attachments: [
          {
            kind: "file",
            name: "result.txt",
            mimeType: "text/plain",
            data: Uint8Array.from([1]),
          },
        ],
      });
    });

    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({
      channel: "telegram",
      direction: "inbound",
      status: "received",
      attachmentCount: 1,
    });
    expect(activity[0]!.text.length).toBe(280);
    expect(activity[1]).toMatchObject({
      direction: "outbound",
      status: "accepted",
      text: "done",
      attachmentCount: 1,
    });
    expect(activity[1]!.requestId).toBe(activity[0]!.requestId);
    expect(sent).toEqual(["done"]);
  });
});
