import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createImGatewayActivityMiddleware,
  ImGatewayService,
  type ImGatewayActivity,
} from "./im-gateway-service.js";

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
    });
    expect(status.channelStatuses.find(({ channel }) => channel === "wechat")).toMatchObject({
      enabled: false,
      state: "disabled",
    });
    expect(status.error).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("secret-token");
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
