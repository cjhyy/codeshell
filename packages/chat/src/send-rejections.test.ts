import { describe, expect, test } from "bun:test";
import { isNotDelivered, NotDeliveredError, type ChannelAdapter } from "./channel.js";
import { LarkAdapter } from "./lark.js";
import { createDesktopNotificationHandler } from "./notification-relay.js";
import { SlackAdapter } from "./slack.js";
import { TelegramAdapter } from "./telegram.js";
import { WechatAdapter, type WechatAdapterState, type WechatStateStore } from "./wechat.js";

/**
 * A send the platform explicitly refused reached no one (NotDeliveredError);
 * a timeout or a reset after the request was written may have. The relay
 * reports the first as not attempted (Desktop then retries or fails it, and
 * the owner's notice waits for their next message) and the second as
 * attempted (on a channel without client ids: unknown, never resent).
 */

const timeout = () => Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });

async function failure(send: () => Promise<void>): Promise<unknown> {
  return send().then(
    () => {
      throw new Error("expected the send to fail");
    },
    (error: unknown) => error,
  );
}

function telegram(respond: () => Promise<Response>) {
  return new TelegramAdapter(
    {
      channel: "telegram",
      botToken: "secret",
      allowedTargetIds: ["123"],
      allowedUserIds: [],
      apiBaseUrl: "https://api.telegram.org",
    },
    { fetch: respond as typeof fetch },
  );
}

function memoryStore(initial: WechatAdapterState): WechatStateStore {
  let value = structuredClone(initial);
  return {
    load: async () => structuredClone(value),
    save: async (next) => {
      value = structuredClone(next);
    },
  };
}

let accounts = 0;

function wechat(respond: () => Promise<Response>) {
  return new WechatAdapter(
    // A fresh account each: a rate limit cools down the whole account.
    { accountId: `abc-im-bot-${(accounts += 1)}`, token: "bot-secret" },
    {
      stateStore: memoryStore({ cursor: "c", contextTokens: {} }),
      sleep: async () => undefined,
      fetch: respond as typeof fetch,
    },
  );
}

function lark(create: () => Promise<unknown>) {
  const adapter = new LarkAdapter({ appId: "app-id", appSecret: "secret" });
  (
    adapter as unknown as { client: { im: { v1: { message: { create: unknown } } } } }
  ).client.im.v1.message.create = create;
  return adapter;
}

function slack(post: () => Promise<unknown>) {
  const adapter = new SlackAdapter({ botToken: "xoxb-token", appToken: "xapp-token" });
  (adapter as unknown as { web: { chat: { postMessage: unknown } } }).web.chat.postMessage = post;
  return adapter;
}

describe("adapters say when a send was refused", () => {
  test("Telegram: an API error is a refusal; a timeout is not", async () => {
    const refused = await failure(() =>
      telegram(async () =>
        Response.json(
          { ok: false, error_code: 400, description: "Bad Request: chat not found" },
          { status: 400 },
        ),
      ).send("123", { text: "hi" }),
    );
    expect(refused).toBeInstanceOf(NotDeliveredError);
    expect(
      isNotDelivered(
        await failure(() =>
          telegram(async () =>
            Response.json(
              { ok: false, error_code: 403, description: "Forbidden: bot was blocked" },
              { status: 403 },
            ),
          ).send("123", { text: "hi" }),
        ),
      ),
    ).toBe(true);
    expect(
      isNotDelivered(
        await failure(() =>
          telegram(async () => Promise.reject(timeout())).send("123", { text: "hi" }),
        ),
      ),
    ).toBe(false);
    // A 5xx says nothing about whether the message went out.
    expect(
      isNotDelivered(
        await failure(() =>
          telegram(async () => new Response("bad gateway", { status: 502 })).send("123", {
            text: "hi",
          }),
        ),
      ),
    ).toBe(false);
  });

  test("WeChat: an iLink error code or a 4xx is a refusal; a socket error is not", async () => {
    // No stored context: the one tokenless try is refused (here: the login expired).
    const stale = await failure(() =>
      wechat(async () => Response.json({ ret: -14, errmsg: "session expired" })).send("owner", {
        text: "hi",
      }),
    );
    expect(isNotDelivered(stale)).toBe(true);
    expect(
      isNotDelivered(
        await failure(() =>
          wechat(async () => new Response("{}", { status: 401 })).send("owner", { text: "hi" }),
        ),
      ),
    ).toBe(true);
    expect(
      isNotDelivered(
        await failure(() =>
          wechat(async () => Promise.reject(timeout())).send("owner", { text: "hi" }),
        ),
      ),
    ).toBe(false);
  });

  test("Lark: an error code or an HTTP 4xx is a refusal; a transport error is not", async () => {
    expect(
      isNotDelivered(
        await failure(() =>
          lark(async () => ({ code: 230002, msg: "bot not in chat" })).send("chat", { text: "hi" }),
        ),
      ),
    ).toBe(true);
    expect(
      isNotDelivered(
        await failure(() =>
          lark(async () =>
            Promise.reject(
              Object.assign(new Error("Request failed"), { response: { status: 403 } }),
            ),
          ).send("chat", { text: "hi" }),
        ),
      ),
    ).toBe(true);
    expect(
      isNotDelivered(
        await failure(() =>
          lark(async () => Promise.reject(timeout())).send("chat", { text: "hi" }),
        ),
      ),
    ).toBe(false);
  });

  test("Slack: a platform error or rate limit is a refusal; a request error is not", async () => {
    const platform = Object.assign(new Error("An API error occurred: channel_not_found"), {
      code: "slack_webapi_platform_error",
    });
    expect(
      isNotDelivered(
        await failure(() => slack(async () => Promise.reject(platform)).send("C1", { text: "hi" })),
      ),
    ).toBe(true);
    const http = Object.assign(new Error("HTTP 404"), {
      code: "slack_webapi_http_error",
      statusCode: 404,
    });
    expect(
      isNotDelivered(
        await failure(() => slack(async () => Promise.reject(http)).send("C1", { text: "hi" })),
      ),
    ).toBe(true);
    const request = Object.assign(new Error("socket hang up"), {
      code: "slack_webapi_request_error",
    });
    expect(
      isNotDelivered(
        await failure(() => slack(async () => Promise.reject(request)).send("C1", { text: "hi" })),
      ),
    ).toBe(false);
  });
});

describe("the relay reports a refusal as not attempted", () => {
  const event = {
    id: 1,
    createdAt: 1,
    deliveryKey: "f".repeat(64),
    type: "pet.task.completed" as const,
    text: "做完了",
    target: { channel: "telegram", target: "123" },
  };
  const adapter = (error: unknown): ChannelAdapter => ({
    channel: "telegram",
    run: async () => undefined,
    send: async () => {
      throw error;
    },
  });
  const relay = (error: unknown) =>
    createDesktopNotificationHandler([adapter(error)], [], { authorizeTarget: () => true })(event, {
      streamId: "a".repeat(32),
    }).catch((failed) => failed);

  test("a definite rejection: not attempted (failed, then queued for the owner)", async () => {
    expect(await relay(new NotDeliveredError("chat not found"))).toMatchObject({
      attempted: false,
      idempotent: true,
    });
  });

  test("a timeout: attempted on a channel without client ids (unknown, never resent)", async () => {
    expect(await relay(timeout())).toMatchObject({ attempted: true, idempotent: false });
  });
});
