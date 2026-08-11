import { describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileWechatStateStore,
  loginWechatWithQr,
  sendWechatDirect,
  WechatAdapter,
  wechatCredentialFingerprint,
  type WechatAdapterState,
  type WechatStateStore,
} from "./wechat.js";

describe("personal WeChat ClawBot", () => {
  test("logs in through Tencent's QR flow and returns reusable credentials", async () => {
    const qrUrls: string[] = [];
    const statuses: string[] = [];
    let pollCount = 0;
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    const result = await loginWechatWithQr({
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("get_bot_qrcode")) {
          return Response.json({ qrcode: "qr-secret", qrcode_img_content: "https://qr.example/1" });
        }
        if (url.includes("get_qrcode_status")) {
          pollCount += 1;
          if (pollCount === 1) return Response.json({ status: "scaned" });
          return Response.json({
            status: "confirmed",
            bot_token: "bot-secret",
            ilink_bot_id: "abc@im.bot",
            ilink_user_id: "owner-user",
            baseurl: "https://ilinkai.weixin.qq.com",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
      sleep: async () => undefined,
      onQrCode: (url) => void qrUrls.push(url),
      onStatus: (status) => void statuses.push(status),
    });

    expect(result).toEqual({
      connected: true,
      credentials: {
        accountId: "abc@im.bot",
        token: "bot-secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
        userId: "owner-user",
      },
    });
    expect(qrUrls).toEqual(["https://qr.example/1"]);
    expect(statuses).toEqual(["scaned", "confirmed"]);
    expect(new Headers(requests[0]?.init?.headers).get("authorizationtype")).toBe(
      "ilink_bot_token",
    );
    expect(new Headers(requests[1]?.init?.headers).has("authorizationtype")).toBe(false);
  });

  test("polls text messages, persists context, and replies with the pairing URL", async () => {
    const controller = new AbortController();
    const store = memoryStore({ cursor: "cursor-1", contextTokens: {} });
    const sentBodies: Array<Record<string, any>> = [];
    const adapter = new WechatAdapter(
      {
        accountId: "abc-im-bot",
        token: "bot-secret",
      },
      {
        now: () => 1_000,
        stateStore: store,
        sleep: async () => undefined,
        fetch: async (input, init) => {
          const url = String(input);
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/getupdates")) {
            expect(body.get_updates_buf).toBe("cursor-1");
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bot-secret");
            return Response.json({
              ret: 0,
              get_updates_buf: "cursor-2",
              msgs: [
                {
                  message_id: 42,
                  from_user_id: "owner-user",
                  to_user_id: "abc@im.bot",
                  create_time_ms: 1_000,
                  message_type: 1,
                  message_state: 2,
                  context_token: "context-secret",
                  item_list: [{ type: 1, text_item: { text: "/open" } }],
                },
              ],
            });
          }
          if (url.endsWith("/ilink/bot/sendmessage")) {
            sentBodies.push(body);
            return Response.json({ ret: 0 });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.run(async (message) => {
      expect(message).toMatchObject({
        channel: "wechat",
        target: "owner-user",
        senderId: "owner-user",
        text: "/open",
        messageId: "42",
      });
      await adapter.send(message.target, {
        text: "隧道已开启",
        button: { text: "打开", url: "https://pair.example/secret" },
      });
      controller.abort();
    }, controller.signal);

    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]?.msg.context_token).toBe("context-secret");
    expect(sentBodies[0]?.msg.item_list[0].text_item.text).toContain(
      "打开: https://pair.example/secret",
    );
    expect(store.current()).toEqual({
      cursor: "cursor-2",
      contextTokens: { "owner-user": "context-secret" },
    });
  });

  test("never follows an API redirect carrying the WeChat bearer token", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new WechatAdapter(
      { accountId: "redirect-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        fetch: async (input, init) => {
          requests.push({ url: String(input), init });
          return new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/collect" },
          });
        },
      },
    );

    await expect(adapter.send("owner-user", { text: "secret-safe" })).rejects.toThrow("HTTP 302");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.redirect).toBe("manual");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer bot-secret");
  });

  test("does not acknowledge the polling cursor until the inbound handler accepts the message", async () => {
    const controller = new AbortController();
    const store = memoryStore({ cursor: "cursor-1", contextTokens: {} });
    const polledCursors: string[] = [];
    let handlerCalls = 0;
    const adapter = new WechatAdapter(
      { accountId: "retry-im-bot", token: "bot-secret" },
      {
        now: () => 1_000,
        stateStore: store,
        sleep: async () => undefined,
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/getupdates")) {
            const body = JSON.parse(String(init?.body));
            polledCursors.push(body.get_updates_buf);
            return Response.json({
              ret: 0,
              get_updates_buf: "cursor-2",
              msgs: [
                {
                  message_id: 77,
                  from_user_id: "owner-user",
                  create_time_ms: 1_000,
                  message_type: 1,
                  message_state: 2,
                  context_token: "fresh-context",
                  item_list: [{ type: 1, text_item: { text: "retry me" } }],
                },
              ],
            });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.run(async () => {
      handlerCalls += 1;
      if (handlerCalls === 1) throw new Error("queue temporarily unavailable");
      controller.abort();
    }, controller.signal);

    expect(handlerCalls).toBe(2);
    expect(polledCursors).toEqual(["cursor-1", "cursor-1"]);
    expect(store.current()).toEqual({
      cursor: "cursor-2",
      contextTokens: { "owner-user": "fresh-context" },
    });
  });

  test("retries a held inbound batch even after the message age window expires", async () => {
    const controller = new AbortController();
    const store = memoryStore({ cursor: "cursor-1", contextTokens: {} });
    let now = 1_000;
    let handlerCalls = 0;
    const adapter = new WechatAdapter(
      { accountId: "aged-retry-im-bot", token: "bot-secret" },
      {
        now: () => now,
        maxMessageAgeMs: 100,
        stateStore: store,
        sleep: async () => undefined,
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/getupdates")) {
            return Response.json({
              ret: 0,
              get_updates_buf: "cursor-2",
              msgs: [
                {
                  message_id: 79,
                  from_user_id: "owner-user",
                  create_time_ms: 1_000,
                  message_type: 1,
                  message_state: 2,
                  item_list: [{ type: 1, text_item: { text: "do not lose me" } }],
                },
              ],
            });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.run(async () => {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        now += 1_000;
        throw new Error("handler stalled past maxMessageAgeMs");
      }
      controller.abort();
    }, controller.signal);

    expect(handlerCalls).toBe(2);
    expect(store.current().cursor).toBe("cursor-2");
  });

  test("stops polling instead of resurrecting state after a QR rebind takes over the state file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codeshell-wechat-rebind-"));
    const statePath = join(directory, "owner.state.json");
    try {
      const staleStore = new FileWechatStateStore(
        statePath,
        wechatCredentialFingerprint("bot-secret"),
      );
      await staleStore.save({ cursor: "cursor-1" });
      const logs: string[] = [];
      let polls = 0;
      const adapter = new WechatAdapter(
        { accountId: "rebind-im-bot", token: "bot-secret" },
        {
          now: () => 1_000,
          stateStore: staleStore,
          log: (message) => void logs.push(message),
          sleep: async () => undefined,
          fetch: async (input) => {
            const url = String(input);
            if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
            if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
            if (url.endsWith("/ilink/bot/getupdates")) {
              polls += 1;
              // The login CLI rebinds via QR while this adapter is mid-poll.
              await new FileWechatStateStore(
                statePath,
                wechatCredentialFingerprint("rotated-secret"),
              ).reset({});
              return Response.json({ ret: 0, get_updates_buf: "cursor-2", msgs: [] });
            }
            throw new Error(`unexpected request: ${url}`);
          },
        },
      );

      await expect(
        adapter.run(async () => undefined, new AbortController().signal),
      ).rejects.toThrow("已被新的扫码绑定接管");
      expect(polls).toBe(1);
      // The fresh binding survives untouched; the stale cursor never lands.
      await expect(
        new FileWechatStateStore(statePath, wechatCredentialFingerprint("rotated-secret")).load(),
      ).resolves.toEqual({});
      expect(logs.filter((line) => line.includes("已被新的扫码绑定接管"))).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retries cursor persistence without redelivering an already accepted inbound message", async () => {
    const controller = new AbortController();
    let persisted: WechatAdapterState = { cursor: "cursor-1", contextTokens: {} };
    let failCursorSaveOnce = true;
    const store: WechatStateStore = {
      load: async () => structuredClone(persisted),
      save: async (state) => {
        if (state.cursor === "cursor-2" && failCursorSaveOnce) {
          failCursorSaveOnce = false;
          throw new Error("disk temporarily unavailable");
        }
        persisted = structuredClone(state);
        if (state.cursor === "cursor-2") controller.abort();
      },
    };
    const polledCursors: string[] = [];
    let handlerCalls = 0;
    const adapter = new WechatAdapter(
      { accountId: "cursor-save-im-bot", token: "bot-secret" },
      {
        now: () => 1_000,
        stateStore: store,
        sleep: async () => undefined,
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/getupdates")) {
            const body = JSON.parse(String(init?.body));
            polledCursors.push(body.get_updates_buf);
            return Response.json({
              ret: 0,
              get_updates_buf: "cursor-2",
              msgs: [
                {
                  message_id: 78,
                  from_user_id: "owner-user",
                  create_time_ms: 1_000,
                  message_type: 1,
                  message_state: 2,
                  item_list: [{ type: 1, text_item: { text: "accept once" } }],
                },
              ],
            });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.run(async () => {
      handlerCalls += 1;
    }, controller.signal);

    expect(handlerCalls).toBe(1);
    expect(polledCursors).toEqual(["cursor-1", "cursor-1"]);
    expect(persisted).toEqual({ cursor: "cursor-2", contextTokens: {} });
  });

  test("clears stale context and retries prepare failed tokenless with the same client id", async () => {
    const store = memoryStore({
      cursor: "cursor-1",
      contextTokens: { "owner-user": "stale-context" },
    });
    const bodies: Record<string, any>[] = [];
    const logs: string[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: store,
        log: (message) => void logs.push(message),
        fetch: async (input, init) => {
          if (String(input).endsWith("/ilink/bot/sendmessage")) {
            bodies.push(JSON.parse(String(init?.body)));
            return bodies.length === 1
              ? Response.json({ ret: 1, errmsg: "prepare failed" })
              : Response.json({ ret: 0 });
          }
          throw new Error(`unexpected request: ${String(input)}`);
        },
      },
    );

    await adapter.send("owner-user", { text: "测试消息" });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.msg.context_token).toBe("stale-context");
    expect(bodies[1]?.msg).not.toHaveProperty("context_token");
    expect(bodies[1]?.msg.client_id).toBe(bodies[0]?.msg.client_id);
    expect(store.current()).toEqual({ cursor: "cursor-1", contextTokens: {} });
    expect(logs.join("\n")).toContain("已清除并尝试无上下文直发");

    const restartedBodies: Record<string, any>[] = [];
    const restarted = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: store,
        fetch: async (_input, init) => {
          restartedBodies.push(JSON.parse(String(init?.body)));
          return Response.json({ ret: 0 });
        },
      },
    );
    await restarted.send("owner-user", { text: "再次发送" });
    expect(restartedBodies[0]?.msg).not.toHaveProperty("context_token");
  });

  test("keeps the tokenless fallback available when stale-state persistence fails", async () => {
    const bodies: Record<string, any>[] = [];
    const logs: string[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: {
          load: async () => ({ contextTokens: { "owner-user": "stale-context" } }),
          save: async () => {
            throw new Error("disk is read-only");
          },
        },
        log: (message) => void logs.push(message),
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return bodies.length === 1
            ? Response.json({ ret: 1, errmsg: "prepare failed" })
            : Response.json({ ret: 0 });
        },
      },
    );

    await adapter.send("owner-user", { text: "测试消息" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.msg).not.toHaveProperty("context_token");
    expect(logs.join("\n")).toContain("disk is read-only");
  });

  test("supports one-shot proactive delivery without conversation context", async () => {
    const bodies: Record<string, any>[] = [];
    const result = await sendWechatDirect(
      { accountId: "abc-im-bot", token: "bot-secret" },
      "owner-user",
      { text: "测试消息" },
      {
        stateStore: memoryStore({ contextTokens: {} }),
        fetch: async (input, init) => {
          expect(String(input).endsWith("/ilink/bot/sendmessage")).toBe(true);
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({ ret: 0 });
        },
      },
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.msg).not.toHaveProperty("context_token");
    expect(result).toEqual({
      channel: "wechat",
      target: "owner-user",
      status: "accepted",
      terminalDeliveryConfirmed: false,
      viaLiveAdapter: false,
    });
  });

  test("routes direct delivery through the live long-poll adapter", async () => {
    const controller = new AbortController();
    let markPolling!: () => void;
    const polling = new Promise<void>((resolve) => {
      markPolling = resolve;
    });
    const bodies: Record<string, any>[] = [];
    const config = { accountId: "live-im-bot", token: "live-secret" };
    const adapter = new WechatAdapter(config, {
      stateStore: memoryStore({ contextTokens: {} }),
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
        if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
        if (url.endsWith("/ilink/bot/getupdates")) {
          markPolling();
          await new Promise<void>((resolve) => {
            if (init?.signal?.aborted) resolve();
            else init?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return Response.json({ ret: 0, msgs: [] });
        }
        if (url.endsWith("/ilink/bot/sendmessage")) {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({ ret: 0 });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const run = adapter.run(async () => undefined, controller.signal);
    await polling;

    await expect(
      sendWechatDirect({ ...config, token: "rotated-live-secret" }, "owner-user", {
        text: "不应与旧会话竞争",
      }),
    ).rejects.toThrow("凭据已更新");
    const result = await sendWechatDirect(
      config,
      "owner-user",
      { text: "复用在线连接" },
      {
        fetch: async () => {
          throw new Error("one-shot adapter must not be constructed while live");
        },
      },
    );
    controller.abort();
    await run;

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.msg.item_list[0].text_item.text).toBe("复用在线连接");
    expect(result).toMatchObject({ status: "accepted", viaLiveAdapter: true });
  });

  test("drains an already accepted live direct send before notifying session stop", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let markPolling!: () => void;
    const polling = new Promise<void>((resolve) => {
      markPolling = resolve;
    });
    let markSendEntered!: () => void;
    const sendEntered = new Promise<void>((resolve) => {
      markSendEntered = resolve;
    });
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const config = { accountId: "live-drain-im-bot", token: "live-drain-secret" };
    const adapter = new WechatAdapter(config, {
      stateStore: memoryStore({ contextTokens: {} }),
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/ilink/bot/msg/notifystart")) {
          calls.push("start");
          return Response.json({ ret: 0 });
        }
        if (url.endsWith("/ilink/bot/msg/notifystop")) {
          calls.push("stop");
          return Response.json({ ret: 0 });
        }
        if (url.endsWith("/ilink/bot/getupdates")) {
          markPolling();
          await new Promise<void>((resolve) => {
            if (init?.signal?.aborted) resolve();
            else init?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return Response.json({ ret: 0, msgs: [] });
        }
        if (url.endsWith("/ilink/bot/sendmessage")) {
          calls.push("send-start");
          markSendEntered();
          await sendGate;
          calls.push("send-end");
          return Response.json({ ret: 0 });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    let runSettled = false;
    const run = adapter
      .run(async () => undefined, controller.signal)
      .finally(() => {
        runSettled = true;
      });
    await polling;
    const direct = sendWechatDirect(config, "owner-user", { text: "finish before stop" });
    await sendEntered;

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(runSettled).toBe(false);
    expect(calls).toEqual(["start", "send-start"]);

    releaseSend();
    await direct;
    await run;
    expect(calls).toEqual(["start", "send-start", "send-end", "stop"]);
  });

  test("rejects a second live long-poll adapter for the same account after token rotation", async () => {
    const controller = new AbortController();
    let markPolling!: () => void;
    const polling = new Promise<void>((resolve) => {
      markPolling = resolve;
    });
    const config = { accountId: "single-live-im-bot", token: "single-live-secret" };
    const first = new WechatAdapter(config, {
      stateStore: memoryStore({ contextTokens: {} }),
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
        if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
        if (url.endsWith("/ilink/bot/getupdates")) {
          markPolling();
          await new Promise<void>((resolve) => {
            if (init?.signal?.aborted) resolve();
            else init?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return Response.json({ ret: 0, msgs: [] });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const run = first.run(async () => undefined, controller.signal);
    await polling;
    try {
      const second = new WechatAdapter(
        { ...config, token: "rotated-single-live-secret" },
        {
          stateStore: memoryStore({ contextTokens: {} }),
          fetch: async () => {
            throw new Error("duplicate adapter must not make a request");
          },
        },
      );
      await expect(second.run(async () => undefined, new AbortController().signal)).rejects.toThrow(
        "已有一个长轮询 adapter",
      );
    } finally {
      controller.abort();
      await run;
    }
  });

  test("serializes one-shot direct helpers for the same account", async () => {
    const bodies: Record<string, any>[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolveEntered) => {
      markFirstEntered = resolveEntered;
    });
    const options = {
      stateStore: memoryStore({ contextTokens: {} }),
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          markFirstEntered();
          await firstGate;
        }
        return Response.json({ ret: 0 });
      },
    };
    const config = { accountId: "abc-im-bot", token: "bot-secret" };

    const first = sendWechatDirect(config, "owner-user", { text: "第一条" }, options);
    await firstEntered;
    const second = sendWechatDirect(
      { ...config, accountId: "ABC-IM-BOT" },
      "owner-user",
      { text: "第二条" },
      options,
    );
    await Promise.resolve();
    expect(bodies).toHaveLength(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(bodies.map((body) => body.msg.item_list[0].text_item.text)).toEqual([
      "第一条",
      "第二条",
    ]);
  });

  test("serializes separate adapter instances through the same account boundary", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const first = new WechatAdapter(
      { accountId: "shared-account-im-bot", token: "first-token" },
      {
        stateStore: memoryStore({ contextTokens: {} }),
        fetch: async () => {
          calls.push("first");
          markFirstEntered();
          await firstGate;
          return Response.json({ ret: 0 });
        },
      },
    );
    const second = new WechatAdapter(
      { accountId: "SHARED-ACCOUNT-IM-BOT", token: "rotated-token" },
      {
        stateStore: memoryStore({ contextTokens: {} }),
        fetch: async () => {
          calls.push("second");
          return Response.json({ ret: 0 });
        },
      },
    );

    const firstSend = first.send("owner-user", { text: "first" });
    await firstEntered;
    const secondSend = second.send("owner-user", { text: "second" });
    await Promise.resolve();
    expect(calls).toEqual(["first"]);
    releaseFirst();
    await Promise.all([firstSend, secondSend]);
    expect(calls).toEqual(["first", "second"]);
  });

  test("serializes concurrent sends so visible items keep call order", async () => {
    const bodies: Record<string, any>[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolveEntered) => {
      markFirstEntered = resolveEntered;
    });
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: memoryStore({ contextTokens: {} }),
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          if (bodies.length === 1) {
            markFirstEntered();
            await firstGate;
          }
          return Response.json({ ret: 0 });
        },
      },
    );

    const first = adapter.send("owner-user", { text: "第一条" });
    await firstEntered;
    const second = adapter.send("owner-user", { text: "第二条" });
    await Promise.resolve();
    expect(bodies).toHaveLength(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(bodies.map((body) => body.msg.item_list[0].text_item.text)).toEqual([
      "第一条",
      "第二条",
    ]);
  });

  test("rejects an empty direct message and chunks long Unicode text safely", async () => {
    const bodies: Record<string, any>[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: memoryStore({ contextTokens: {} }),
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({ ret: 0 });
        },
      },
    );

    await expect(adapter.send("owner-user", { text: "" })).rejects.toThrow("消息不能为空");
    expect(bodies).toHaveLength(0);

    const longText = `${"a".repeat(7_999)}🙂b`;
    await adapter.send("owner-user", { text: longText });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.msg.item_list[0].text_item.text).toBe(`${"a".repeat(7_999)}🙂`);
    expect(bodies[1]?.msg.item_list[0].text_item.text).toBe("b");
  });

  test("recognizes Hermes-compatible stale codes but retries only explicit stale failures", async () => {
    for (const stale of [
      { ret: -14, errmsg: "context expired" },
      { errcode: -2, errmsg: "unknown error" },
    ]) {
      const bodies: Record<string, any>[] = [];
      const adapter = new WechatAdapter(
        { accountId: "abc-im-bot", token: "bot-secret" },
        {
          stateStore: ownerContextStore(),
          fetch: async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return bodies.length === 1 ? Response.json(stale) : Response.json({ ret: 0 });
          },
        },
      );
      await adapter.send("owner-user", { text: "测试消息" });
      expect(bodies).toHaveLength(2);
      expect(bodies[1]?.msg.client_id).toBe(bodies[0]?.msg.client_id);
      expect(bodies[1]?.msg).not.toHaveProperty("context_token");
    }

    let attempts = 0;
    const rejected = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        fetch: async () => {
          attempts += 1;
          return Response.json({ ret: 403, errmsg: "permission denied" });
        },
      },
    );
    await expect(rejected.send("owner-user", { text: "测试消息" })).rejects.toThrow(
      "permission denied",
    );
    expect(attempts).toBe(1);
  });

  test("does not retry an ambiguous transport failure that may already have been accepted", async () => {
    let attempts = 0;
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        fetch: async () => {
          attempts += 1;
          throw new Error("socket closed before response");
        },
      },
    );

    await expect(adapter.send("owner-user", { text: "只能发一次" })).rejects.toThrow(
      "socket closed before response",
    );
    expect(attempts).toBe(1);
  });

  test("reuses the platform client id when DeliveryQueue retries an ambiguous send", async () => {
    const bodies: Record<string, any>[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          if (bodies.length === 1) throw new Error("response lost after platform acceptance");
          return Response.json({ ret: 0 });
        },
      },
    );
    const reply = { text: "任务已派出，完成后发给你。" };

    await expect(adapter.send("owner-user", reply)).rejects.toThrow(
      "response lost after platform acceptance",
    );
    await adapter.send("owner-user", reply);

    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.msg.client_id).toBe(bodies[0]?.msg.client_id);
  });

  test("backs off explicit rate limits while reusing the same client id and context", async () => {
    const bodies: Record<string, any>[] = [];
    const delays: number[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        rateLimitRetries: 2,
        rateLimitRetryBaseMs: 250,
        sleep: async (ms) => void delays.push(ms),
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return bodies.length < 3
            ? Response.json({ ret: -2, errmsg: "frequency limit" })
            : Response.json({ ret: 0 });
        },
      },
    );

    await adapter.send("owner-user", { text: "测试消息" });

    expect(delays).toEqual([250, 500]);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((body) => body.msg.client_id)).size).toBe(1);
    expect(bodies.every((body) => body.msg.context_token === "context-secret")).toBe(true);
  });

  test("retries explicit HTTP 429 but not ambiguous HTTP 5xx responses", async () => {
    const bodies: Record<string, any>[] = [];
    const delays: number[] = [];
    const throttled = new WechatAdapter(
      { accountId: "http-rate-im-bot", token: "bot-secret" },
      {
        stateStore: memoryStore({ contextTokens: {} }),
        rateLimitRetries: 1,
        rateLimitRetryBaseMs: 200,
        sleep: async (ms) => void delays.push(ms),
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return bodies.length === 1
            ? new Response(null, { status: 429 })
            : Response.json({ ret: 0 });
        },
      },
    );
    await throttled.send("owner-user", { text: "限流后重试" });
    expect(delays).toEqual([200]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.msg.client_id).toBe(bodies[0]?.msg.client_id);

    let serverErrors = 0;
    const ambiguous = new WechatAdapter(
      { accountId: "http-error-im-bot", token: "bot-secret" },
      {
        stateStore: memoryStore({ contextTokens: {} }),
        fetch: async () => {
          serverErrors += 1;
          return new Response(null, { status: 503 });
        },
      },
    );
    await expect(ambiguous.send("owner-user", { text: "不应重试" })).rejects.toThrow("HTTP 503");
    expect(serverErrors).toBe(1);
  });

  test("opens an account-wide cooldown after explicit rate limits are exhausted", async () => {
    let requests = 0;
    const config = { accountId: "cooldown-im-bot", token: "bot-secret" };
    const limited = new WechatAdapter(config, {
      now: () => 1_000,
      stateStore: memoryStore({ contextTokens: {} }),
      rateLimitRetries: 0,
      rateLimitCooldownMs: 30_000,
      fetch: async () => {
        requests += 1;
        return Response.json({ ret: -2, errmsg: "frequency limit" });
      },
    });
    await expect(limited.send("owner-user", { text: "第一条" })).rejects.toThrow("frequency limit");

    const blocked = new WechatAdapter(
      { ...config, token: "rotated-secret" },
      {
        now: () => 1_500,
        stateStore: memoryStore({ contextTokens: {} }),
        fetch: async () => {
          requests += 1;
          return Response.json({ ret: 0 });
        },
      },
    );
    await expect(blocked.send("owner-user", { text: "第二条" })).rejects.toThrow(
      "冷却还剩 29500ms",
    );
    expect(requests).toBe(1);

    const recovered = new WechatAdapter(config, {
      now: () => 31_000,
      stateStore: memoryStore({ contextTokens: {} }),
      fetch: async () => {
        requests += 1;
        return Response.json({ ret: 0 });
      },
    });
    await recovered.send("owner-user", { text: "第三条" });
    expect(requests).toBe(2);
  });

  test("rejects unsafe rate-limit retry settings before any request", () => {
    expect(
      () =>
        new WechatAdapter(
          { accountId: "abc-im-bot", token: "bot-secret" },
          { rateLimitRetries: -1 },
        ),
    ).toThrow("微信限流重试次数必须是 0 到 5 之间的整数");
    expect(
      () =>
        new WechatAdapter(
          { accountId: "abc-im-bot", token: "bot-secret" },
          { rateLimitRetryBaseMs: Number.NaN },
        ),
    ).toThrow("微信限流退避时间必须是 1 到 30000 之间的整数");
    expect(
      () =>
        new WechatAdapter(
          { accountId: "abc-im-bot", token: "bot-secret" },
          { rateLimitCooldownMs: 300_001 },
        ),
    ).toThrow("微信限流冷却时间必须是 0 到 300000 之间的整数");
  });

  test("surfaces a failed tokenless fallback and keeps stale context cleared", async () => {
    const store = memoryStore({ contextTokens: { "owner-user": "stale-context" } });
    let attempts = 0;
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: store,
        rateLimitRetries: 0,
        rateLimitCooldownMs: 0,
        fetch: async () => {
          attempts += 1;
          return attempts === 1
            ? Response.json({ ret: 1, errmsg: "prepare failed" })
            : Response.json({ ret: 429, errmsg: "rate limited" });
        },
      },
    );

    await expect(adapter.send("owner-user", { text: "测试消息" })).rejects.toThrow(
      "微信直接发送失败：rate limited",
    );
    expect(attempts).toBe(2);
    expect(store.current().contextTokens).toEqual({});
  });

  test("explains that prepare failed without context needs a fresh inbound message", async () => {
    let attempts = 0;
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: memoryStore({ contextTokens: {} }),
        fetch: async () => {
          attempts += 1;
          return Response.json({ ret: 1, errmsg: "prepare failed" });
        },
      },
    );

    await expect(adapter.send("owner-user", { text: "测试消息" })).rejects.toThrow(
      "当前微信会话没有可用的 context_token；请先让管理员向 Mimi 发一条消息刷新会话上下文",
    );
    expect(attempts).toBe(1);
  });

  test("downloads and decrypts personal WeChat image media lazily", async () => {
    const controller = new AbortController();
    const key = randomBytes(16);
    const plaintext = Buffer.from("image-bytes");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const requests: string[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        now: () => 1_000,
        fetch: async (input) => {
          const url = String(input);
          requests.push(url);
          if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/getupdates")) {
            return Response.json({
              ret: 0,
              msgs: [
                {
                  message_id: 43,
                  from_user_id: "owner-user",
                  create_time_ms: 1_000,
                  message_type: 1,
                  message_state: 2,
                  item_list: [
                    {
                      type: 2,
                      msg_id: "image-43",
                      image_item: {
                        media: {
                          full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?id=43",
                          aes_key: key.toString("base64"),
                        },
                      },
                    },
                  ],
                },
              ],
            });
          }
          if (url.includes("novac2c.cdn.weixin.qq.com")) return new Response(encrypted);
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.run(async (message) => {
      expect(message.text).toBe("");
      expect(message.attachments?.[0]).toMatchObject({ id: "image-43", kind: "image" });
      expect(requests.some((url) => url.includes("novac2c.cdn.weixin.qq.com"))).toBe(false);
      expect(Buffer.from(await message.attachments![0]!.load())).toEqual(plaintext);
      controller.abort();
    }, controller.signal);
  });

  test("rejects an inbound media URL outside the WeChat CDN allowlist before fetching it", async () => {
    const controller = new AbortController();
    const requests: string[] = [];
    const adapter = new WechatAdapter(
      { accountId: "cdn-guard-im-bot", token: "bot-secret" },
      {
        now: () => 1_000,
        fetch: async (input) => {
          const url = String(input);
          requests.push(url);
          if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/getupdates")) {
            return Response.json({
              ret: 0,
              msgs: [
                {
                  message_id: 44,
                  from_user_id: "owner-user",
                  create_time_ms: 1_000,
                  message_type: 1,
                  message_state: 2,
                  item_list: [
                    {
                      type: 2,
                      image_item: {
                        media: {
                          full_url: "https://attacker.example/internal",
                          aes_key: randomBytes(16).toString("base64"),
                        },
                      },
                    },
                  ],
                },
              ],
            });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.run(async (message) => {
      await expect(message.attachments![0]!.load()).rejects.toThrow("不在受信任主机列表");
      controller.abort();
    }, controller.signal);
    expect(requests).not.toContain("https://attacker.example/internal");
  });

  test("extends the CDN download allowlist with configured extra hosts, HTTPS only", async () => {
    const key = randomBytes(16);
    const plaintext = Buffer.from("regional-image");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const regionalHost = "novac2c-region2.cdn.weixin.qq.com";
    const runDownload = async (fullUrl: string): Promise<Uint8Array> => {
      const controller = new AbortController();
      let loaded: Uint8Array | undefined;
      const adapter = new WechatAdapter(
        {
          accountId: "cdn-extra-im-bot",
          token: "bot-secret",
          extraCdnDownloadHosts: [regionalHost],
        },
        {
          now: () => 1_000,
          fetch: async (input) => {
            const url = String(input);
            if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
            if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
            if (url.endsWith("/ilink/bot/getupdates")) {
              return Response.json({
                ret: 0,
                msgs: [
                  {
                    message_id: 46,
                    from_user_id: "owner-user",
                    create_time_ms: 1_000,
                    message_type: 1,
                    message_state: 2,
                    item_list: [
                      {
                        type: 2,
                        msg_id: "image-46",
                        image_item: {
                          media: { full_url: fullUrl, aes_key: key.toString("base64") },
                        },
                      },
                    ],
                  },
                ],
              });
            }
            if (url === fullUrl && new URL(url).protocol === "https:") {
              return new Response(encrypted);
            }
            throw new Error(`unexpected request: ${url}`);
          },
        },
      );
      let failure: unknown;
      await adapter.run(async (message) => {
        try {
          loaded = await message.attachments![0]!.load();
        } catch (error) {
          failure = error;
        } finally {
          controller.abort();
        }
      }, controller.signal);
      if (failure) throw failure;
      if (!loaded) throw new Error("attachment did not load");
      return loaded;
    };

    const bytes = await runDownload(`https://${regionalHost}/c2c/download?id=46`);
    expect(Buffer.from(bytes)).toEqual(plaintext);

    // The extra allowlist never weakens the HTTPS requirement.
    await expect(runDownload(`http://${regionalHost}/c2c/download?id=46`)).rejects.toThrow(
      "必须使用 HTTPS",
    );
  });

  test("rejects extra CDN hosts that are not exact hostnames before any request", () => {
    for (const invalid of ["https://evil.example", "evil.example/path", "evil.example:8443", ""]) {
      expect(
        () =>
          new WechatAdapter({
            accountId: "cdn-invalid-im-bot",
            token: "bot-secret",
            extraCdnDownloadHosts: [invalid],
          }),
      ).toThrow("微信附件 CDN 额外主机必须是纯主机名");
    }
  });

  test("revalidates every WeChat CDN redirect before following it", async () => {
    const controller = new AbortController();
    const cdnRequests: string[] = [];
    const adapter = new WechatAdapter(
      { accountId: "cdn-redirect-im-bot", token: "bot-secret" },
      {
        now: () => 1_000,
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/getupdates")) {
            return Response.json({
              ret: 0,
              msgs: [
                {
                  message_id: 45,
                  from_user_id: "owner-user",
                  create_time_ms: 1_000,
                  message_type: 1,
                  message_state: 2,
                  item_list: [
                    {
                      type: 2,
                      image_item: {
                        media: {
                          full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?id=redirect",
                          aes_key: randomBytes(16).toString("base64"),
                        },
                      },
                    },
                  ],
                },
              ],
            });
          }
          if (url.includes("novac2c.cdn.weixin.qq.com")) {
            cdnRequests.push(url);
            return new Response(null, {
              status: 302,
              headers: { location: "https://127.0.0.1/private" },
            });
          }
          cdnRequests.push(url);
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.run(async (message) => {
      await expect(message.attachments![0]!.load()).rejects.toThrow("不在受信任主机列表");
      controller.abort();
    }, controller.signal);
    expect(cdnRequests).toEqual(["https://novac2c.cdn.weixin.qq.com/c2c/download?id=redirect"]);
  });

  test("uploads encrypted generated images and sends the returned CDN media reference", async () => {
    const requestedBodies: Record<string, any> = {};
    let encryptedUpload = Buffer.alloc(0);
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/getuploadurl")) {
            requestedBodies.getUploadUrl = JSON.parse(String(init?.body));
            return Response.json({ ret: 0, upload_param: "upload-secret" });
          }
          if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?")) {
            encryptedUpload = Buffer.from(init?.body as Uint8Array);
            return new Response(null, {
              status: 200,
              headers: { "x-encrypted-param": "download-secret" },
            });
          }
          if (url.endsWith("/ilink/bot/sendmessage")) {
            requestedBodies.sendMessage = JSON.parse(String(init?.body));
            return Response.json({ ret: 0 });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );
    const plaintext = Uint8Array.from([1, 2, 3, 4, 5]);

    await adapter.send("owner-user", {
      text: "",
      attachments: [
        {
          kind: "image",
          name: "comic.png",
          mimeType: "image/png",
          data: plaintext,
        },
      ],
    });

    expect(requestedBodies.getUploadUrl).toMatchObject({
      media_type: 1,
      to_user_id: "owner-user",
      rawsize: plaintext.byteLength,
      no_need_thumb: true,
    });
    expect(requestedBodies.getUploadUrl.rawfilemd5).toMatch(/^[a-f0-9]{32}$/);
    expect(requestedBodies.getUploadUrl.aeskey).toMatch(/^[a-f0-9]{32}$/);
    expect(encryptedUpload.byteLength).toBe(16);
    expect(encryptedUpload.equals(Buffer.from(plaintext))).toBe(false);
    expect(requestedBodies.sendMessage.msg.item_list).toEqual([
      {
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: "download-secret",
            aes_key: Buffer.from(requestedBodies.getUploadUrl.aeskey).toString("base64"),
            encrypt_type: 1,
          },
          mid_size: 16,
        },
      },
    ]);
  });

  test("retries a media send tokenless without uploading the media twice", async () => {
    const store = memoryStore({ contextTokens: { "owner-user": "stale-context" } });
    let uploadUrlRequests = 0;
    let cdnUploads = 0;
    const sendBodies: Record<string, any>[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: store,
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/getuploadurl")) {
            uploadUrlRequests += 1;
            return Response.json({ ret: 0, upload_param: "upload-once" });
          }
          if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?")) {
            cdnUploads += 1;
            return new Response(null, {
              status: 200,
              headers: { "x-encrypted-param": "download-once" },
            });
          }
          if (url.endsWith("/ilink/bot/sendmessage")) {
            sendBodies.push(JSON.parse(String(init?.body)));
            return sendBodies.length === 1
              ? Response.json({ ret: 1, errmsg: "prepare failed" })
              : Response.json({ ret: 0 });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.send("owner-user", {
      text: "",
      attachments: [
        {
          kind: "image",
          name: "comic.png",
          mimeType: "image/png",
          data: Uint8Array.from([1, 2, 3]),
        },
      ],
    });

    expect(uploadUrlRequests).toBe(1);
    expect(cdnUploads).toBe(1);
    expect(sendBodies).toHaveLength(2);
    expect(sendBodies[1]?.msg.client_id).toBe(sendBodies[0]?.msg.client_id);
    expect(sendBodies[1]?.msg.item_list).toEqual(sendBodies[0]?.msg.item_list);
    expect(sendBodies[1]?.msg).not.toHaveProperty("context_token");
    expect(store.current().contextTokens).toEqual({});
  });

  test("rejects upload URL errors reported through errcode before contacting the CDN", async () => {
    let cdnRequested = false;
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/getuploadurl")) {
            return Response.json({ ret: 0, errcode: 403, errmsg: "upload forbidden" });
          }
          cdnRequested = true;
          return Response.json({ ret: 0 });
        },
      },
    );

    await expect(
      adapter.send("owner-user", {
        text: "",
        attachments: [
          {
            kind: "file",
            name: "report.pdf",
            mimeType: "application/pdf",
            data: Uint8Array.from([1]),
          },
        ],
      }),
    ).rejects.toThrow("微信获取附件上传地址失败：upload forbidden");
    expect(cdnRequested).toBe(false);
  });

  test("retries transient CDN upload failures with the same ciphertext", async () => {
    let cdnAttempts = 0;
    const uploadedBodies: Buffer[] = [];
    const sleeps: number[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        sleep: async (ms) => void sleeps.push(ms),
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/getuploadurl")) {
            return Response.json({ ret: 0, upload_param: "upload-retry" });
          }
          if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?")) {
            cdnAttempts += 1;
            uploadedBodies.push(Buffer.from(init?.body as Uint8Array));
            if (cdnAttempts === 1) return new Response(null, { status: 503 });
            if (cdnAttempts === 2) return new Response(null, { status: 200 });
            return new Response(null, {
              status: 200,
              headers: { "x-encrypted-param": "download-after-retry" },
            });
          }
          if (url.endsWith("/ilink/bot/sendmessage")) return Response.json({ ret: 0 });
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.send("owner-user", {
      text: "",
      attachments: [
        {
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          data: Uint8Array.from([1, 2, 3]),
        },
      ],
    });

    expect(cdnAttempts).toBe(3);
    expect(sleeps).toEqual([250, 500]);
    expect(uploadedBodies[1]).toEqual(uploadedBodies[0]);
    expect(uploadedBodies[2]).toEqual(uploadedBodies[0]);
  });

  test("does not retry a CDN client rejection", async () => {
    let cdnAttempts = 0;
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        sleep: async () => {
          throw new Error("must not sleep");
        },
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/getuploadurl")) {
            return Response.json({ ret: 0, upload_param: "upload-forbidden" });
          }
          if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?")) {
            cdnAttempts += 1;
            return new Response(null, { status: 403 });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await expect(
      adapter.send("owner-user", {
        text: "",
        attachments: [
          {
            kind: "file",
            name: "report.pdf",
            mimeType: "application/pdf",
            data: Uint8Array.from([1]),
          },
        ],
      }),
    ).rejects.toThrow("HTTP 403");
    expect(cdnAttempts).toBe(1);
  });

  test("does not follow or retry a CDN upload redirect", async () => {
    let cdnAttempts = 0;
    const redirects: Array<RequestRedirect | undefined> = [];
    const adapter = new WechatAdapter(
      { accountId: "cdn-redirect-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        sleep: async () => {
          throw new Error("must not retry a redirect");
        },
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/getuploadurl")) {
            return Response.json({ ret: 0, upload_param: "upload-redirect" });
          }
          if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?")) {
            cdnAttempts += 1;
            redirects.push(init?.redirect);
            return new Response(null, {
              status: 307,
              headers: { location: "https://127.0.0.1/internal" },
            });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await expect(
      adapter.send("owner-user", {
        text: "",
        attachments: [
          {
            kind: "file",
            name: "report.pdf",
            mimeType: "application/pdf",
            data: Uint8Array.from([1]),
          },
        ],
      }),
    ).rejects.toThrow("HTTP 307");
    expect(cdnAttempts).toBe(1);
    expect(redirects).toEqual(["manual"]);
  });

  test("uploads generic files with media_type FILE and sends a file item", async () => {
    const requestedBodies: Record<string, any> = {};
    const sentBodies: Record<string, any>[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/getuploadurl")) {
            requestedBodies.getUploadUrl = JSON.parse(String(init?.body));
            return Response.json({ ret: 0, upload_param: "upload-file" });
          }
          if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?")) {
            return new Response(null, {
              status: 200,
              headers: { "x-encrypted-param": "download-file" },
            });
          }
          if (url.endsWith("/ilink/bot/sendmessage")) {
            sentBodies.push(JSON.parse(String(init?.body)));
            return Response.json({ ret: 0 });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );
    const plaintext = Uint8Array.from([10, 20, 30]);

    await adapter.send("owner-user", {
      text: "报告在附件中",
      attachments: [
        {
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          data: plaintext,
        },
      ],
    });

    expect(requestedBodies.getUploadUrl).toMatchObject({
      media_type: 3,
      to_user_id: "owner-user",
      rawsize: plaintext.byteLength,
      no_need_thumb: true,
    });
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies.map((body) => body.msg.item_list)).toEqual([
      [{ type: 1, text_item: { text: "报告在附件中" } }],
      [
        {
          type: 4,
          file_item: {
            media: {
              encrypt_query_param: "download-file",
              aes_key: Buffer.from(requestedBodies.getUploadUrl.aeskey).toString("base64"),
              encrypt_type: 1,
            },
            file_name: "report.pdf",
            len: String(plaintext.byteLength),
          },
        },
      ],
    ]);
  });

  test("uploads video with the native WeChat video item shape", async () => {
    const bodies: Record<string, any> = {};
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/getuploadurl")) {
            bodies.upload = JSON.parse(String(init?.body));
            return Response.json({ ret: 0, upload_param: "upload-video" });
          }
          if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?")) {
            return new Response(null, {
              status: 200,
              headers: { "x-encrypted-param": "download-video" },
            });
          }
          if (url.endsWith("/ilink/bot/sendmessage")) {
            bodies.send = JSON.parse(String(init?.body));
            return Response.json({ ret: 0 });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.send("owner-user", {
      text: "",
      attachments: [
        {
          kind: "video",
          name: "clip.mp4",
          mimeType: "video/mp4",
          data: Uint8Array.from([1, 2, 3]),
        },
      ],
    });

    expect(bodies.upload.media_type).toBe(2);
    expect(bodies.send.msg.item_list[0]).toMatchObject({
      type: 5,
      video_item: {
        media: { encrypt_query_param: "download-video", encrypt_type: 1 },
        video_size: 16,
        play_length: 0,
      },
    });
    expect(bodies.send.msg.item_list[0].video_item.video_md5).toMatch(/^[a-f0-9]{32}$/);
  });

  test("retries a failed media sub-step without duplicating delivered text", async () => {
    let uploadAttempts = 0;
    const sentItems: any[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        stateStore: ownerContextStore(),
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/sendmessage")) {
            sentItems.push(JSON.parse(String(init?.body)).msg.item_list[0]);
            return Response.json({ ret: 0 });
          }
          if (url.endsWith("/ilink/bot/getuploadurl")) {
            uploadAttempts += 1;
            if (uploadAttempts === 1) throw new Error("temporary upload failure");
            return Response.json({ ret: 0, upload_param: "retry-upload" });
          }
          if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?")) {
            return new Response(null, {
              status: 200,
              headers: { "x-encrypted-param": "retry-download" },
            });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );
    const message = {
      text: "caption",
      attachments: [
        {
          kind: "file" as const,
          name: "report.pdf",
          mimeType: "application/pdf",
          data: Uint8Array.from([1]),
        },
      ],
    };

    await expect(adapter.send("owner-user", message)).rejects.toThrow("temporary upload failure");
    await adapter.send("owner-user", message);

    expect(sentItems.filter((item) => item.type === 1)).toHaveLength(1);
    expect(sentItems.filter((item) => item.type === 4)).toHaveLength(1);
  });
});

function memoryStore(initial: WechatAdapterState): WechatStateStore & {
  current(): WechatAdapterState;
} {
  let value = structuredClone(initial);
  return {
    load: async () => structuredClone(value),
    save: async (next) => {
      value = structuredClone(next);
    },
    current: () => structuredClone(value),
  };
}

function ownerContextStore(): WechatStateStore {
  return memoryStore({ contextTokens: { "owner-user": "context-secret" } });
}
