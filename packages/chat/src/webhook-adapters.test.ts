import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ChannelMessage } from "./channel.js";
import { LineAdapter } from "./line.js";
import { WhatsAppAdapter } from "./whatsapp.js";

describe("webhook adapters", () => {
  test("LINE validates the raw-body signature before dispatching a text message", async () => {
    const body = Buffer.from(
      JSON.stringify({
        events: [
          {
            type: "message",
            source: { groupId: "group-1", userId: "user-1" },
            message: { type: "text", text: "/status" },
          },
        ],
      }),
    );
    const signature = createHmac("sha256", "line-secret").update(body).digest("base64");
    const adapter = new LineAdapter({
      channel: "line",
      channelSecret: "line-secret",
      channelAccessToken: "line-token",
      allowedTargetIds: ["group-1"],
      allowedUserIds: ["user-1"],
    });
    const response = fakeResponse();
    const messages: ChannelMessage[] = [];

    await adapter.handleWebhook(
      fakeRequest(body, "POST", "/webhooks/line", { "x-line-signature": signature }),
      response.value,
      async (message) => {
        messages.push(message);
      },
      1024,
    );
    await Promise.resolve();

    expect(response.statusCode()).toBe(200);
    expect(messages).toEqual([
      { channel: "line", target: "group-1", senderId: "user-1", text: "/status" },
    ]);
  });

  test("LINE rejects a forged signature without dispatching", async () => {
    const adapter = new LineAdapter({
      channel: "line",
      channelSecret: "line-secret",
      channelAccessToken: "line-token",
      allowedTargetIds: ["user-1"],
      allowedUserIds: [],
    });
    const response = fakeResponse();
    let handled = false;
    await adapter.handleWebhook(
      fakeRequest(Buffer.from('{"events":[]}'), "POST", "/webhooks/line", {
        "x-line-signature": "forged",
      }),
      response.value,
      async () => {
        handled = true;
      },
      1024,
    );
    expect(response.statusCode()).toBe(401);
    expect(handled).toBe(false);
  });

  test("WhatsApp verifies Meta's challenge token", async () => {
    const adapter = new WhatsAppAdapter(baseWhatsAppConfig());
    const response = fakeResponse();
    await adapter.handleWebhook(
      fakeRequest(
        Buffer.alloc(0),
        "GET",
        "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=abc123",
      ),
      response.value,
      async () => undefined,
      1024,
    );
    expect(response.statusCode()).toBe(200);
    expect(response.body()).toBe("abc123");
  });

  test("WhatsApp sends the pairing URL as a CTA button", async () => {
    let requestBody: any;
    const adapter = new WhatsAppAdapter(baseWhatsAppConfig(), async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    });
    await adapter.send("8613800000000", {
      text: "隧道已开启",
      button: { text: "打开手机遥控", url: "https://pair.example/#token" },
    });

    expect(requestBody.interactive.type).toBe("cta_url");
    expect(requestBody.interactive.action.parameters.url).toBe("https://pair.example/#token");
  });
});

function baseWhatsAppConfig() {
  return {
    channel: "whatsapp" as const,
    accessToken: "wa-token",
    appSecret: "wa-app-secret",
    verifyToken: "verify-secret",
    phoneNumberId: "phone-number-id",
    apiVersion: "v25.0",
    allowedTargetIds: ["8613800000000"],
    allowedUserIds: [],
  };
}

function fakeRequest(
  body: Buffer,
  method: string,
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const request = Readable.from(body.length ? [body] : []) as unknown as IncomingMessage;
  request.method = method;
  request.url = url;
  request.headers = headers;
  return request;
}

function fakeResponse(): {
  value: ServerResponse;
  statusCode: () => number;
  body: () => string;
} {
  let statusCode = 0;
  let body = "";
  const response = {
    headersSent: false,
    set statusCode(value: number) {
      statusCode = value;
    },
    get statusCode() {
      return statusCode;
    },
    setHeader: () => response,
    end: (value?: string | Buffer) => {
      body = value === undefined ? "" : String(value);
      response.headersSent = true;
      return response;
    },
  };
  return {
    value: response as unknown as ServerResponse,
    statusCode: () => statusCode,
    body: () => body,
  };
}
