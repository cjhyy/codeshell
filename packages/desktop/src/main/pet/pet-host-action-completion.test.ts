import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completePetHostActionReceipt,
  PetHostActionReceiptService,
  type PetHostActionCompletedEvent,
} from "./pet-host-action-completion.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pet host-action completion", () => {
  test("persists and publishes one authoritative SendMessage replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-host-completion-"));
    roots.push(root);
    mkdirSync(join(root, "pet-one"));
    const service = new PetHostActionReceiptService({
      sessionsRootDir: root,
      qrDir: join(root, "qr"),
    });
    const events: PetHostActionCompletedEvent[] = [];

    const receipt = await completePetHostActionReceipt({
      recorder: service,
      input: {
        petSessionId: "pet-one",
        clientMessageId: "im:wechat:message-one",
        executions: [
          {
            kind: "outboundMessage",
            payload: { targetId: "owner-one", text: "测试" },
            ok: true,
            result: { label: "微信", accepted: true },
          },
        ],
        authoritativeMessage: "消息已提交到 微信，平台接口已接受发送请求；尚未确认收件设备已展示。",
      },
      publish: (event) => events.push(event),
      now: () => 42,
    });

    expect(receipt).toEqual({
      message: "消息已提交到 微信，平台接口已接受发送请求；尚未确认收件设备已展示。",
      replaceAssistant: true,
    });
    expect(events).toEqual([
      {
        kind: "host-action-completed",
        clientMessageId: "im:wechat:message-one",
        message: "消息已提交到 微信，平台接口已接受发送请求；尚未确认收件设备已展示。",
        replaceAssistant: true,
        createdAt: 42,
      },
    ]);
    const rows = readFileSync(join(root, "pet-one", "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.at(-1)?.data).toMatchObject({
      role: "assistant",
      content: "消息已提交到 微信，平台接口已接受发送请求；尚未确认收件设备已展示。",
      clientMessageId: "pet-host-action-replace-im:wechat:message-one",
    });
  });

  test("does not publish when the recorder has no visible receipt", async () => {
    const events: PetHostActionCompletedEvent[] = [];
    expect(
      await completePetHostActionReceipt({
        recorder: { record: async () => null },
        input: { petSessionId: "pet-one", clientMessageId: "one", executions: [] },
        publish: (event) => events.push(event),
      }),
    ).toBeNull();
    expect(events).toEqual([]);
  });

  test("persists a host-authored delegation launch after rendering action outcomes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-delegation-completion-"));
    roots.push(root);
    mkdirSync(join(root, "pet-one"));
    const service = new PetHostActionReceiptService({
      sessionsRootDir: root,
      qrDir: join(root, "qr"),
    });

    const receipt = await service.record({
      petSessionId: "pet-one",
      clientMessageId: "im:wechat:delegation-one",
      executions: [],
      baseMessage: "任务已启动，正在处理。完成后我会在当前会话回复结果。",
    });

    expect(receipt).toEqual({
      message: "任务已启动，正在处理。完成后我会在当前会话回复结果。",
      replaceAssistant: true,
    });
    const rows = readFileSync(join(root, "pet-one", "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.at(-1)?.data).toMatchObject({
      content: "任务已启动，正在处理。完成后我会在当前会话回复结果。",
      clientMessageId: "pet-host-action-replace-im:wechat:delegation-one",
    });
  });

  test("does not append a duplicate assistant receipt for the same client message", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-host-completion-dedupe-"));
    roots.push(root);
    const service = new PetHostActionReceiptService({
      sessionsRootDir: root,
      qrDir: join(root, "qr"),
    });
    const input = {
      petSessionId: "pet-one",
      clientMessageId: "im:wechat:dedupe-one",
      executions: [],
      authoritativeMessage: "只保留一条回执。",
      replaceAssistant: true,
    } as const;

    await service.record(input);
    await service.record(input);

    const rows = readFileSync(join(root, "pet-one", "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.data.role === "assistant")).toHaveLength(1);
    expect(rows[0]?.data.clientMessageId).toBe("pet-host-action-replace-im:wechat:dedupe-one");
  });

  test("persists a host-handled control turn before its authoritative reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-control-completion-"));
    roots.push(root);
    const service = new PetHostActionReceiptService({
      sessionsRootDir: root,
      qrDir: join(root, "qr"),
    });

    await service.record({
      petSessionId: "pet-one",
      clientMessageId: "clear-one",
      userMessage: "/clear",
      executions: [],
      baseMessage: "上下文已清空。有什么新活要干？",
      replaceAssistant: true,
    });

    const rows = readFileSync(join(root, "pet-one", "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.data.role)).toEqual(["user", "assistant"]);
    expect(rows[0]?.data).toMatchObject({
      content: "/clear",
      clientMessageId: "clear-one",
    });
    expect(rows[1]?.data).toMatchObject({
      content: "上下文已清空。有什么新活要干？",
      clientMessageId: "pet-host-action-replace-clear-one",
    });
  });

  test("persists a Gateway reply as the visible WeChat body with delivery metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-gateway-completion-"));
    roots.push(root);
    mkdirSync(join(root, "pet-one"));
    const service = new PetHostActionReceiptService({
      sessionsRootDir: root,
      qrDir: join(root, "qr"),
    });
    const events: PetHostActionCompletedEvent[] = [];

    const receipt = await completePetHostActionReceipt({
      recorder: service,
      input: {
        petSessionId: "pet-one",
        clientMessageId: "im:wechat:message-one",
        executions: [
          {
            kind: "gatewayReply",
            payload: { text: "Mooncake 分析完成。" },
            ok: true,
            result: { text: "Mooncake 分析完成。" },
          },
        ],
        authoritativeMessage: "Mooncake 分析完成。",
        replaceAssistant: true,
        deliveryChannel: "wechat",
      },
      publish: (event) => events.push(event),
      now: () => 84,
    });

    expect(receipt).toEqual({
      message: "Mooncake 分析完成。",
      replaceAssistant: true,
      deliveryChannel: "wechat",
    });
    expect(events[0]).toMatchObject({
      clientMessageId: "im:wechat:message-one",
      message: "Mooncake 分析完成。",
      replaceAssistant: true,
      deliveryChannel: "wechat",
    });
    const rows = readFileSync(join(root, "pet-one", "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.at(-1)?.data.clientMessageId).toBe(
      "pet-host-action-replace-delivery-wechat:im:wechat:message-one",
    );
  });

  test("still publishes the platform outcome when transcript persistence fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-host-completion-failure-"));
    roots.push(root);
    const blockedRoot = join(root, "not-a-directory");
    writeFileSync(blockedRoot, "blocked");
    const persistErrors: unknown[] = [];
    const service = new PetHostActionReceiptService({
      sessionsRootDir: blockedRoot,
      qrDir: join(root, "qr"),
      onPersistError: (error) => persistErrors.push(error),
    });
    const events: PetHostActionCompletedEvent[] = [];

    await completePetHostActionReceipt({
      recorder: service,
      input: {
        petSessionId: "pet-one",
        clientMessageId: "message-one",
        executions: [
          {
            kind: "outboundMessage",
            payload: { targetId: "owner-one", text: "测试" },
            ok: true,
            result: { label: "微信", accepted: true },
          },
        ],
        authoritativeMessage: "微信平台已接受发送请求。",
      },
      publish: (event) => events.push(event),
    });

    expect(persistErrors).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      message: "微信平台已接受发送请求。",
      replaceAssistant: true,
    });
  });
});
