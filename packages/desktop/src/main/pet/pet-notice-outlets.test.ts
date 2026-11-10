import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SID,
  cleanupNoticeEnv,
  env,
  harness,
  longTask,
  resetNoticeEnv,
  sourceFile,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let current: Harness | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

describe("burst load", () => {
  test("a burst of notices reads the owner channels and targets once", async () => {
    const reads = { channels: 0, targets: 0 };
    const sends: string[] = [];
    current = harness({
      gateway: {
        ownerChannels: () => {
          reads.channels += 1;
          return [
            {
              id: "wechat",
              label: "微信",
              ready: "ready",
              targetId: "wechat:owner",
              isDirect: true,
            },
          ];
        },
        listOwnerMessageTargets: () => {
          reads.targets += 1;
          return [];
        },
        sendOwnerMessage: async (_targetId, text) => {
          sends.push(text);
          return {};
        },
        supportsIdempotentOwnerSend: () => true,
        lastOwnerInboundChannel: () => "wechat",
        isOwnerConversation: () => false,
      },
      readSettings: () => ({ pet: { notifications: { quietHours: { enabled: false } } } }),
    });
    for (let index = 0; index < 5; index += 1)
      await current.wiring.router.submit({
        kind: "session.done",
        priority: "P1",
        dedupeKey: `done:burst-${index}`,
        sessionId: `s-${index}`,
        ruleIds: [],
        facts: { title: `任务${index}` },
        attention: "always",
        channel: "auto",
        target: { kind: "owner" },
      });
    expect(sends).toHaveLength(5);
    expect(reads).toEqual({ channels: 1, targets: 1 });
  });
});

describe("owner attachments", () => {
  test("owner-target media is filtered by the target's capabilities", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat" }));
    const media = {
      attachments: [
        {
          kind: "file" as const,
          name: "a.zip",
          mimeType: "application/zip",
          size: 10,
          path: await sourceFile("a.zip", 10),
        },
        {
          kind: "image" as const,
          name: "big.png",
          mimeType: "image/png",
          size: 5_000,
          path: await sourceFile("big.png", 5_000),
        },
        {
          kind: "image" as const,
          name: "a.png",
          mimeType: "image/png",
          size: 10,
          path: await sourceFile("a.png", 10),
        },
        {
          kind: "image" as const,
          name: "b.png",
          mimeType: "image/png",
          size: 10,
          path: await sourceFile("b.png", 10),
        },
      ],
      button: { text: "查看", url: "https://example.com/r" },
    };
    await current.wiring.notifyTaskClosed(longTask(), { text: "好了", media });
    // WeChat target: images only, ≤1 000 bytes, at most one.
    expect(current.materialized).toEqual([[expect.stringMatching(/\/2\.png$/u)]]);
    // Accepted: the copies are gone.
    expect(await readdir(join(env.dir, "pet", "notice-media"))).toEqual([]);
    expect(current.ownerSends).toEqual([
      {
        targetId: "wechat:owner",
        text: "好了\n查看：https://example.com/r",
        key: expect.stringMatching(/^[0-9a-f]{24}$/u),
        attachments: ["a.png"],
      },
    ]);
  });
});
