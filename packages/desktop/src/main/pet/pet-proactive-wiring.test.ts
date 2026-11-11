import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PetProactive } from "./pet-proactive.js";
import { wirePetProactive } from "./pet-proactive-wiring.js";
import type { SystemScheduleNoticeRule } from "./pet-rule-store.js";
import {
  cleanupNoticeEnv,
  env,
  harness,
  longTask,
  resetNoticeEnv,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let notices: Harness | undefined;
let proactive: PetProactive | undefined;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await resetNoticeEnv();
  globalThis.fetch = (() => {
    throw new Error("Unexpected native provider network request");
  }) as typeof fetch;
});

afterEach(async () => {
  proactive?.dispose();
  proactive = undefined;
  await cleanupNoticeEnv(notices);
  notices = undefined;
  globalThis.fetch = originalFetch;
});

async function select(model: string) {
  await mkdir(join(env.dir, ".code-shell"), { recursive: true });
  await writeFile(
    join(env.dir, ".code-shell", "settings.json"),
    JSON.stringify({ sessionDefaults: { model } }),
  );
}

describe("Main proactive model wiring", () => {
  test("settings changed after start select a fresh external provider for each brief", async () => {
    await select("fixture-native");
    notices = harness({
      readSettings: () => ({
        pet: {
          notifications: { briefs: { morning: { enabled: true }, evening: { enabled: true } } },
        },
      }),
    });
    await notices.wiring.ready;
    notices.sessions.splice(0);
    const at = Date.now();
    notices.tasks.push(
      longTask({ createdAt: at - 2_000, updatedAt: at - 1_000, completedAt: at - 1_000 }),
    );
    const selected: string[] = [];
    proactive = wirePetProactive({
      notices: notices.wiring,
      userDataDir: env.dir,
      cwd: env.dir,
      tasks: () => notices!.tasks,
      projection: () => ({ sessions: notices!.sessions, pending: notices!.pending }),
      externalReplyModel: async (model) => {
        selected.push(model);
        return '{"items":[{"refs":["r1"],"text":"修复完成"}]}';
      },
      log: () => undefined,
    });
    await proactive.start();
    expect(selected).toEqual([]);
    for (const [kind, model] of [
      ["morning", "codex/gpt-6.1-sol"],
      ["evening", "claude-code/sonnet"],
    ] as const) {
      await select(model);
      const rule = notices.wiring.ruleStore.get(`system-brief-${kind}`) as SystemScheduleNoticeRule;
      expect(
        await proactive.fire(rule, {
          occurrence: at,
          deadline: at + 60_000,
          key: `brief-provider-${kind}`,
        }),
      ).toMatchObject({ status: "notified" });
    }
    expect(selected).toEqual(["codex/gpt-6.1-sol", "claude-code/sonnet"]);
  });
});
