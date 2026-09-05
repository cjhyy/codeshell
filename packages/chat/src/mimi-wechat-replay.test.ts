import { describe, expect, test } from "bun:test";
import { createCipheriv, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGateway, createAllowlistMiddleware } from "./chat-gateway.js";
import { createCodeShellRemoteCommands, createMimiPetChat } from "./gateway.js";
import type { DesktopControlClient } from "./desktop-control-client.js";
import { WechatAdapter, type WechatAdapterState } from "./wechat.js";

type PetChat = DesktopControlClient["petChat"];
type WireMessage = {
  message_id: number;
  from_user_id: string;
  context_token?: string;
  message_type?: number;
  message_state?: number;
  item_list: Array<Record<string, unknown>>;
};
type WireSend = {
  to_user_id: string;
  client_id: string;
  context_token?: string;
  item_list: Array<{ type: number; text_item?: { text: string } }>;
};

// These tests exercise the real polling adapter, durable inbox, middleware,
// reply cache and iLink payload generation. Only HTTP and desktop model dispatch
// are substituted; no logged-in account, external service or live LLM is used.
describe("Mimi conversations through simulated WeChat", () => {
  test("preserves Chinese follow-ups, voice transcription and natural-language remote requests", async () => {
    const inputs = [
      "帮我开一下手机遥控",
      "先不要执行，解释一下",
      "继续刚才那个任务，不要新建",
      "这是一个新任务，帮我排查 Mimi 的回复问题",
    ];
    const seen: Array<Parameters<PetChat>[0]> = [];
    const replay = await createReplay(async (input) => {
      seen.push(input);
      return { text: `收到：${input.message}`, petSessionId: "mimi-replay" };
    });
    try {
      for (const [index, text] of inputs.entries()) {
        replay.enqueue([
          index === 2
            ? {
                ...inbound(index + 1, ""),
                item_list: [{ type: 3, voice_item: { text } }],
              }
            : inbound(index + 1, text),
        ]);
        await replay.idle(index + 1);
      }
      expect(seen.map((input) => input.message)).toEqual(inputs);
      expect(seen.map((input) => input.origin?.messageId)).toEqual(["1", "2", "3", "4"]);
      expect(seen.every((input) => input.origin?.channel === "wechat")).toBe(true);
      expect(replay.texts()).toEqual(inputs.map((text) => `收到：${text}`));
      expect(replay.remoteCommands()).toBe(0);
      expect(replay.errors).toEqual([]);
    } finally {
      await replay.stop();
    }
  });

  test("admits a burst while Mimi is running, suppresses steered followers and deduplicates redelivery", async () => {
    const leader = deferred<Awaited<ReturnType<PetChat>>>();
    const seen: string[] = [];
    const replay = await createReplay(async ({ message }) => {
      seen.push(message);
      if (seen.length === 1) return leader.promise;
      return { text: "", petSessionId: "mimi-replay", suppressReply: true, reason: "steered" };
    });
    try {
      replay.enqueue([
        inbound(10, "帮我画一下架构图"),
        inbound(11, "用中文"),
        inbound(12, "先解释方案再动手"),
        inbound(11, "用中文"),
      ]);
      await waitUntil(() => seen.length === 3);
      expect(replay.sent).toHaveLength(0);
      leader.resolve({ text: "会先用中文说明架构图方案。", petSessionId: "mimi-replay" });
      await replay.idle(1);
      expect(seen).toEqual(["帮我画一下架构图", "用中文", "先解释方案再动手"]);
      expect(replay.texts()).toEqual(["会先用中文说明架构图方案。"]);
      expect(replay.sent[0]?.context_token).toBe("context-12");
      expect(replay.errors).toEqual([]);
    } finally {
      leader.resolve({ text: "", petSessionId: "mimi-replay", suppressReply: true });
      await replay.stop();
    }
  });

  test("uses accepted image bytes even when the WeChat CDN URL expires immediately after spooling", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const key = Buffer.alloc(16, 7);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
    let downloads = 0;
    const seen: Array<Parameters<PetChat>[0]> = [];
    const replay = await createReplay(
      async (input) => {
        seen.push(input);
        return { text: "图片已收到，可以继续分析。", petSessionId: "mimi-replay" };
      },
      {
        media: () => {
          downloads += 1;
          return downloads === 1
            ? new Response(encrypted)
            : new Response("expired CDN URL", { status: 403 });
        },
      },
    );
    try {
      replay.enqueue([
        {
          ...inbound(20, ""),
          item_list: [
            {
              type: 2,
              msg_id: "image-only-20",
              image_item: {
                media: {
                  full_url: "https://novac2c.cdn.weixin.qq.com/c2c/replay-image",
                  aes_key: key.toString("base64"),
                },
              },
            },
          ],
        },
      ]);
      await replay.idle(1);
      expect(downloads).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.message).toBe("");
      expect(seen[0]?.attachments).toEqual([
        {
          id: "image-only-20",
          kind: "image",
          name: "wechat-image.jpg",
          mimeType: "image/png",
          size: png.byteLength,
          dataBase64: png.toString("base64"),
        },
      ]);
      expect(replay.texts()).toEqual(["图片已收到，可以继续分析。"]);
      expect(replay.errors).toEqual([]);
    } finally {
      await replay.stop();
    }
  });

  test("retries an ambiguous send acknowledgement with the same payload and client ID without rerunning Mimi", async () => {
    let modelCalls = 0;
    const reply = "处理结果：" + "中".repeat(3_500) + "🐱";
    const replay = await createReplay(
      async () => {
        modelCalls += 1;
        return { text: reply, petSessionId: "mimi-replay" };
      },
      {
        send: (_message, attempt) => {
          if (attempt === 1) throw new Error("simulated lost HTTP acknowledgement");
          return Response.json({ ret: 0 });
        },
      },
    );
    try {
      replay.enqueue([inbound(30, "分析这篇文章")]);
      await replay.idle(1);
      expect(modelCalls).toBe(1);
      expect(replay.sent).toHaveLength(2);
      expect(replay.sent[1]).toEqual(replay.sent[0]);
      expect(replay.texts()).toEqual([reply, reply]);
      expect(replay.errors).toHaveLength(1);
      expect(String(replay.errors[0])).toContain("lost HTTP acknowledgement");
    } finally {
      await replay.stop();
    }
  });

  test("delivers a pending reply after a fresh inbound context arrives without repeating the accepted action", async () => {
    const seen: string[] = [];
    const replay = await createReplay(
      async ({ message }) => {
        seen.push(message);
        return message === "刷新一下"
          ? { text: "", petSessionId: "mimi-replay", suppressReply: true }
          : { text: "已登记你的工作任务。", petSessionId: "mimi-replay" };
      },
      {
        retryBaseMs: 50,
        send: (message) =>
          Response.json(
            message.context_token === "context-41"
              ? { ret: 0 }
              : { ret: -1, errmsg: "context token expired: prepare failed" },
          ),
      },
    );
    try {
      replay.enqueue([inbound(40, "帮我排查这个问题")]);
      await waitUntil(() => replay.errors.length === 1);
      replay.enqueue([inbound(41, "刷新一下")]);
      await replay.idle(2);
      expect(seen).toEqual(["帮我排查这个问题", "刷新一下"]);
      expect(replay.sent).toHaveLength(3);
      expect(replay.sent.map((message) => message.context_token)).toEqual([
        "context-40",
        undefined,
        "context-41",
      ]);
      expect(new Set(replay.sent.map((message) => message.client_id)).size).toBe(1);
      expect(replay.texts()).toEqual(Array(3).fill("已登记你的工作任务。"));
    } finally {
      await replay.stop();
    }
  });

  test("drops unapproved senders and bot echoes before model dispatch", async () => {
    const seen: string[] = [];
    const replay = await createReplay(async ({ message }) => {
      seen.push(message);
      return { text: "只回复当前主人", petSessionId: "mimi-replay" };
    });
    try {
      replay.enqueue([
        { ...inbound(50, "别人的请求"), from_user_id: "another-user" },
        { ...inbound(51, "机器人自己的回复"), message_type: 2 },
        { ...inbound(52, "还没有生成完的消息"), message_state: 1 },
        inbound(53, "你好 Mimi"),
      ]);
      await replay.idle(1);
      expect(seen).toEqual(["你好 Mimi"]);
      expect(replay.texts()).toEqual(["只回复当前主人"]);
      expect(replay.sent[0]?.to_user_id).toBe("owner-user");
    } finally {
      await replay.stop();
    }
  });
});

function inbound(id: number, text: string): WireMessage {
  return {
    message_id: id,
    from_user_id: "owner-user",
    context_token: `context-${id}`,
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

async function createReplay(
  petChat: PetChat,
  options: {
    media?: () => Response;
    send?: (message: WireSend, attempt: number) => Response;
    retryBaseMs?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mimi-wechat-replay-"));
  const path = join(root, "inbox.json");
  const controller = new AbortController();
  const batches: WireMessage[][] = [];
  const sent: WireSend[] = [];
  const errors: unknown[] = [];
  let state: WechatAdapterState = { contextTokens: {} };
  let poll: ((batch: WireMessage[]) => void) | undefined;
  let deliveredBatches = 0;
  let remoteCommands = 0;
  const adapter = new WechatAdapter(
    { accountId: `replay-${randomUUID()}`, token: "fake-replay-token" },
    {
      stateStore: {
        load: () => structuredClone(state),
        save: (next) => {
          state = structuredClone(next);
        },
      },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/notifystart") || url.pathname.endsWith("/notifystop")) {
          return Response.json({ ret: 0 });
        }
        if (url.pathname.endsWith("/getupdates")) {
          const batch = batches.shift() ?? (await nextBatch(init?.signal));
          if (batch.length) deliveredBatches += 1;
          return Response.json({
            ret: 0,
            get_updates_buf: `cursor-${deliveredBatches}`,
            msgs: batch,
          });
        }
        if (url.pathname.endsWith("/sendmessage")) {
          const message = JSON.parse(String(init?.body)).msg as WireSend;
          sent.push(message);
          return options.send?.(message, sent.length) ?? Response.json({ ret: 0 });
        }
        if (url.hostname === "novac2c.cdn.weixin.qq.com" && options.media) return options.media();
        throw new Error(`Unexpected simulated WeChat request: ${url}`);
      },
      log: () => undefined,
    },
  );
  const gateway = new ChatGateway({
    adapters: [adapter],
    delivery: {
      path,
      maxConcurrent: 4,
      maxPerTarget: 4,
      retryBaseMs: options.retryBaseMs ?? 5,
      retryMaxMs: options.retryBaseMs ?? 5,
    },
    onError: (error) => void errors.push(error),
  });
  gateway.use(createAllowlistMiddleware({ wechat: { targetIds: ["owner-user"] } }));
  const unexpectedRemote = async (): Promise<never> => {
    remoteCommands += 1;
    throw new Error("Natural language must reach Mimi before choosing a host action");
  };
  gateway.use(
    createCodeShellRemoteCommands({
      desktop: { open: unexpectedRemote, close: unexpectedRemote, status: unexpectedRemote },
    }),
  );
  gateway.use(createMimiPetChat({ desktop: { petChat }, channels: [adapter] }));
  const running = gateway.run(controller.signal);

  function nextBatch(signal: AbortSignal | null | undefined): Promise<WireMessage[]> {
    return new Promise((resolve) => {
      const abort = () => receive([]);
      const receive = (batch: WireMessage[]) => {
        signal?.removeEventListener("abort", abort);
        if (poll === receive) poll = undefined;
        resolve(batch);
      };
      poll = receive;
      if (signal?.aborted) receive([]);
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  return {
    sent,
    errors,
    remoteCommands: () => remoteCommands,
    texts: () => sent.flatMap((message) => message.item_list.map((item) => item.text_item?.text)),
    enqueue(batch: WireMessage[]) {
      if (poll) poll(batch);
      else batches.push(batch);
    },
    async idle(expectedBatches: number) {
      await waitUntil(async () => {
        if (deliveredBatches < expectedBatches || !poll) return false;
        const status = gateway.healthSnapshot().inbox as { pending: number; inFlight: number };
        if (status.pending || status.inFlight) return false;
        const persisted = JSON.parse(await readFile(path, "utf8"));
        return persisted.pending.length === 0;
      });
    },
    async stop() {
      controller.abort();
      await running;
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Simulated WeChat conversation did not settle");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
