import { expect, test } from "bun:test";

// This fixture has no server, account, SDK connection, or platform send. Every
// transport is an injected in-memory callback; unexpected default fetch fails.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("Audit fixture prohibits default network fetch");
}) as typeof fetch;
const { LineAdapter } = await import("../../../packages/chat/src/line.ts");
const { ChatGateway } = await import("../../../packages/chat/src/chat-gateway.ts");
const { createMimiPetChat } = await import("../../../packages/chat/src/gateway.ts");
const { splitNotificationText } = await import("../../../packages/chat/src/notification-relay.ts");

type Payload = { to: string; messages: Array<Record<string, any>> };
async function projectReply(button: { text: string; url: string }) {
  const payloads: Payload[] = [];
  const transport = (async (_url: unknown, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const adapter = new LineAdapter({ channelSecret: "owned-fixture", channelAccessToken: "owned-fixture" }, transport);
  let receivedOrigin: any;
  const gateway = new ChatGateway({ adapters: [adapter] });
  gateway.use(createMimiPetChat({ desktop: { petChat: async (input: any) => {
    receivedOrigin = input.origin;
    return { text: "The requested document is ready.", petSessionId: "owned-session", button };
  } } }));
  await gateway.dispatch(adapter, {
    channel: "line", target: "owned-conversation", senderId: "owned-sender",
    isDirectMessage: true, text: "Please return the document link.", messageId: "owned-inbound",
  });
  const action = payloads[0]?.messages[1]?.template?.actions?.[0];
  return { payloads, action, receivedOrigin };
}

test("current ordinary Mimi reply path keeps LINE labels beyond the documented 20-character template limit", async () => {
  try {
    const receipts = [];
    for (const length of [20, 21, 80, 81]) {
      const { payloads, action, receivedOrigin } = await projectReply({ text: "L".repeat(length), url: "https://example.test/document" });
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!.messages[0]!.text).toBe("The requested document is ready.");
      expect(receivedOrigin.channel).toBe("line");
      expect(receivedOrigin.capabilities.outbound.button).toBe("native");
      if (length <= 80) {
        expect(action.label.length).toBe(length);
        expect(action.type).toBe("uri");
        expect(payloads[0]!.messages[1]!.template.type).toBe("buttons");
      } else {
        expect(action).toBeUndefined();
      }
      receipts.push({ inputLabelLength: length, projectedLabelLength: action?.label?.length ?? null, messageCount: payloads[0]!.messages.length });
    }
    console.log(JSON.stringify({ case: "line_native_label_contract", documentedTemplateLabelMaximum: 20, receipts }));
  } finally { globalThis.fetch = originalFetch; }
});

test("current ordinary Mimi reply path keeps LINE action URIs beyond the documented 1000-character limit", async () => {
  const receipts = [];
  for (const length of [1000, 1001, 2048, 2049]) {
    const prefix = "https://example.test/";
    const { payloads, action } = await projectReply({ text: "Open", url: prefix + "a".repeat(length - prefix.length) });
    expect(payloads).toHaveLength(1);
    if (length <= 2048) {
      expect(action.uri.length).toBe(length);
      expect(action.label).toBe("Open");
    } else {
      expect(action).toBeUndefined();
    }
    receipts.push({ inputUriLength: length, projectedUriLength: action?.uri?.length ?? null, messageCount: payloads[0]!.messages.length });
  }
  console.log(JSON.stringify({ case: "line_native_uri_contract", documentedUriMaximum: 1000, receipts }));
});

test("shared ordinary chunking retains Unicode and whitespace within the requested limit", () => {
  const text = "  Alpha 😀\n" + "中 😀 x ".repeat(420) + "\n  tail  ";
  const receipts = [];
  for (const maximum of [2, 17, 1800]) {
    const chunks = splitNotificationText(text, maximum);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk: string) => chunk.length <= maximum)).toBe(true);
    expect(chunks.every((chunk: string) => chunk.isWellFormed())).toBe(true);
    receipts.push({ maximum, chunkCount: chunks.length, largestChunk: Math.max(...chunks.map((chunk: string) => chunk.length)) });
  }
  console.log(JSON.stringify({ case: "shared_chunking_controls", inputLength: text.length, receipts }));
});
