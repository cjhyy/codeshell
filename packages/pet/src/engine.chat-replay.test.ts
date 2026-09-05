import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@cjhyy/code-shell-core";
import {
  LLMClientBase,
  registerProvider,
  type CreateMessageOptions,
  type LLMResponse,
  type StreamEvent,
} from "@cjhyy/code-shell-core/extension";
import { createPetModule } from "./capability.js";
import { sessionSelectorId } from "./disclosure/selector.js";
import { PET_BEHAVIOR_PROFILE } from "./profile.js";

/**
 * Script the LLM only; real Engine history, disclosure tools, profile services,
 * validation and host-action receipts remain in the loop. No provider network,
 * desktop host, WeChat adapter or external side effect is executed here.
 */
type Script = (
  options: CreateMessageOptions,
  round: number,
) => Pick<LLMResponse, "text" | "toolCalls">;
interface Replay {
  script: Script;
  rounds: CreateMessageOptions[];
  summaries: CreateMessageOptions[];
}

function modelSnapshot(options: CreateMessageOptions): CreateMessageOptions {
  // Summary calls may carry a live stream callback; retain model-visible
  // inputs only, never clone execution callbacks or cancellation signals.
  return structuredClone({
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    tools: options.tools,
  });
}

const replays = new Map<string, Replay>();
const tempDirs: string[] = [];
const provider = "fake-mimi-chat-replay";

class ChatReplayClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const replay = replays.get(this.model)!;
    let reply: Pick<LLMResponse, "text" | "toolCalls">;
    if ((options.tools ?? []).some((tool) => tool.name === "FollowUps")) {
      replay.rounds.push(modelSnapshot(options));
      reply = replay.script(options, replay.rounds.length);
    } else {
      if (JSON.stringify(options.messages).includes("Turn limit reached")) {
        replay.summaries.push(modelSnapshot(options));
      }
      // Also satisfies auxiliary title generation without consuming a turn.
      reply = { text: "这次没有启动工作，需要先确认可用的原会话。", toolCalls: [] };
    }
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    this.recordUsage(usage, options);
    return { ...reply, stopReason: reply.toolCalls.length ? "tool_use" : "stop", usage };
  }
}

registerProvider(provider, ChatReplayClient);

afterEach(() => {
  replays.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function call(toolName: string, args: Record<string, unknown>, id = toolName) {
  return { text: "", toolCalls: [{ id, toolName, args }] };
}

function createReplay(script: Script) {
  const cwd = mkdtempSync(join(tmpdir(), "mimi-chat-replay-"));
  tempDirs.push(cwd);
  const model = `replay-${crypto.randomUUID()}`;
  const replay: Replay = { script, rounds: [], summaries: [] };
  replays.set(model, replay);
  const sessionsRootDir = join(cwd, "sessions");
  const engine = new Engine({
    llm: { provider, model, apiKey: "test" } as never,
    cwd,
    modules: [createPetModule()],
    sessionStorageDir: sessionsRootDir,
    settingsScope: "isolated",
    headless: true,
    maxTurns: 30,
  });
  (engine as any).hooks.clear();
  const sessionId = "mimi-replay";
  const profileParams = {
    sessionsRootDir,
    hostActions: ["gatewayReply", "followUpMutation"],
    gatewayReply: {
      button: "link",
      attachments: [],
      maxTextLength: 8_000,
      maxAttachments: 4,
      maxAttachmentBytes: 10 * 1024 * 1024,
    },
    workspaces: [
      { id: "ws-project", name: "CodeShell" },
      { id: "ws-no-workspace", name: "未关联项目" },
    ],
    reusableSessions: [
      { id: sessionSelectorId("work-release"), name: "发布准备", workspaceId: "ws-project" },
    ],
    runtimeContext: JSON.stringify({
      currentMessageSource: { kind: "gateway", channel: "wechat" },
    }),
  };
  const events: StreamEvent[] = [];
  return {
    cwd,
    engine,
    replay,
    sessionsRootDir,
    events,
    run: (input: string, overrides: Record<string, unknown> = {}) =>
      engine.run(input, {
        sessionId,
        kind: "pet",
        behaviorMode: "pet",
        onStream: (event) => events.push(event),
        profileParams: { ...profileParams, ...overrides },
      }),
  };
}

function toolResults(events: StreamEvent[]) {
  return events.flatMap((event) => (event.type === "tool_result" ? [event.result] : []));
}

function toolResultJson(options: CreateMessageOptions, toolCallId: string) {
  const results = options.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter(
          (block) => block.type === "tool_result" && block.tool_use_id === toolCallId,
        )
      : [],
  );
  return JSON.parse(String(results.at(-1)?.content));
}

describe("Mimi mocked multi-turn chat replay", () => {
  test("recovers the historical wrong-workspace continuation without starting replacement work", async () => {
    const selector = sessionSelectorId("work-release");
    const replay = createReplay((_options, round) => {
      if (round === 1) return call("GatewayReply", { text: "发布准备在原来的 CodeShell 会话中。" });
      if (round === 2) {
        return call(
          "DelegateWork",
          {
            workspace_id: "ws-no-workspace",
            session_id: selector,
            objective: "继续发布准备，整理发布说明；保留已完成内容，不发布。",
          },
          "wrong-workspace",
        );
      }
      if (round === 3) {
        return call(
          "DelegateWork",
          {
            workspace_id: "ws-project",
            session_id: selector,
            objective: "继续发布准备，整理发布说明；保留已完成内容，不发布。",
          },
          "correct-workspace",
        );
      }
      return { text: "", toolCalls: [] };
    });

    await replay.run("刚才的发布准备在哪？只整理说明，不发布。");
    const result = await replay.run("继续刚才那个，不要另起会话");

    expect(replay.replay.rounds).toHaveLength(4);
    const continuation = replay.replay.rounds[1]!;
    expect(JSON.stringify(continuation.messages)).toContain("只整理说明，不发布");
    expect(JSON.stringify(continuation.messages)).toContain("继续刚才那个，不要另起会话");
    expect(
      toolResults(replay.events).find((entry) => entry.id === "wrong-workspace"),
    ).toMatchObject({
      isError: true,
    });
    expect(JSON.stringify(replay.replay.rounds[2]!.messages)).toContain(
      "Do not send this pair again",
    );
    expect(result.petWorkDelegation).toEqual({
      workspaceId: "ws-project",
      reusableSessionId: selector,
      objective: "继续发布准备，整理发布说明；保留已完成内容，不发布。",
    });
    expect(result.extensions?.pet).not.toHaveProperty("hostActions");
  });

  test("corrects Sessions list arguments and preserves the listed choice across a terse follow-up", async () => {
    const selector = sessionSelectorId("work-release");
    const replay = createReplay((_options, round) => {
      if (round === 1) {
        return call(
          "Sessions",
          { action: "list", session_id: "work-release", query: "发布" },
          "bad-list",
        );
      }
      if (round === 2) return call("Sessions", { action: "list" }, "correct-list");
      if (round === 3) return call("GatewayReply", { text: "1. 发布准备（CodeShell）" });
      if (round === 4) return call("Sessions", { action: "describe", session_id: "work-release" });
      if (round === 5) {
        return call("DelegateWork", {
          workspace_id: "ws-project",
          session_id: selector,
          objective: "继续发布准备：核对已整理的发布说明，仅补全缺失说明，不发布。",
        });
      }
      return { text: "", toolCalls: [] };
    });
    const workDir = join(replay.sessionsRootDir, "work-release");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, "state.json"),
      JSON.stringify({
        sessionId: "work-release",
        kind: "work",
        title: "发布准备",
        cwd: "/work/codeshell",
      }),
    );
    writeFileSync(
      join(workDir, "transcript.jsonl"),
      JSON.stringify({
        id: "work-result",
        type: "message",
        timestamp: 1,
        turnNumber: 0,
        data: { role: "assistant", content: "发布说明已整理一半，尚未发布。" },
      }) + "\n",
    );

    await replay.run("看看有哪些会话");
    const result = await replay.run("就第一个，继续整理说明，不要发布");

    expect(replay.replay.rounds).toHaveLength(6);
    expect(toolResults(replay.events).find((entry) => entry.id === "bad-list")).toMatchObject({
      isError: true,
    });
    expect(JSON.stringify(replay.replay.rounds[1]!.messages)).toContain(
      "list accepts no other arguments",
    );
    expect(JSON.stringify(replay.replay.rounds[2]!.messages)).toContain(selector);
    expect(JSON.stringify(replay.replay.rounds[3]!.messages)).toContain("1. 发布准备");
    expect(JSON.stringify(replay.replay.rounds[4]!.messages)).toContain("发布说明已整理一半");
    expect(result.petWorkDelegation).toMatchObject({
      workspaceId: "ws-project",
      reusableSessionId: selector,
    });
  });

  test("routes a disclosed follow-up using the actual returned field names and leaves it open", async () => {
    const selector = sessionSelectorId("work-release");
    const replay = createReplay((options, round) => {
      if (round === 1) return call("FollowUps", { action: "list" });
      if (round === 2) {
        // Resolve the real tool result, rather than supplying an independently
        // hardcoded target that could hide a broken disclosure contract.
        const row = toolResultJson(options, "FollowUps").followUps[0];
        expect(options.tools?.find((tool) => tool.name === "FollowUps")?.description).toContain(
          "sessionSelector to DelegateWork as session_id",
        );
        return call("DelegateWork", {
          workspace_id: row.workspaceId,
          session_id: row.sessionSelector,
          objective: "继续原发布准备会话，补全发布说明。",
        });
      }
      return { text: "", toolCalls: [] };
    });
    const result = await replay.run("把需要跟进的发布说明继续做完", {
      followUps: [
        {
          id: "followup-release",
          title: "发布说明",
          text: "补全发布说明",
          terminalAt: 1,
          sessionSelector: selector,
          workspaceId: "ws-project",
        },
      ],
    });

    expect(replay.replay.rounds).toHaveLength(3);
    expect(result.petWorkDelegation?.reusableSessionId).toBe(selector);
    expect(result.extensions?.pet).not.toHaveProperty("hostActions");
    expect(toolResults(replay.events)).toHaveLength(2);
  });

  test("wires the desktop time-to-WeChat request through CurrentTime and an authorized SendMessage target", async () => {
    let outboundText = "";
    const replay = createReplay((options, round) => {
      if (round === 1) return call("CurrentTime", {});
      if (round === 2 || round === 3) {
        const time = toolResultJson(options, "CurrentTime");
        outboundText = `现在是 ${time.local}（${time.timeZone}，UTC${time.utcOffset}）。`;
        const properties = options.tools?.find((tool) => tool.name === "SendMessage")?.inputSchema
          .properties as Record<string, { enum: string[] }>;
        return call(
          "SendMessage",
          {
            target_id: round === 2 ? "wechat" : properties.target_id!.enum[0],
            text: outboundText,
          },
          round === 2 ? "raw-channel-rejected" : "authorized-target",
        );
      }
      return { text: "", toolCalls: [] };
    });
    const before = Date.now();
    const result = await replay.run("给微信说一下现在几点了", {
      hostActions: ["outboundMessage"],
      gatewayReply: undefined,
      runtimeContext: JSON.stringify({ currentMessageSource: { kind: "desktop" } }),
      outboundTargets: [
        {
          id: "owner-wechat-7ac291",
          channel: "wechat",
          label: "主人微信",
          maxTextLength: 8_000,
          attachments: [],
          maxAttachments: 0,
          maxAttachmentBytes: 0,
        },
      ],
    });

    expect(replay.replay.rounds).toHaveLength(4);
    expect(replay.replay.rounds[0]!.tools?.map((tool) => tool.name)).toContain("CurrentTime");
    expect(replay.replay.rounds[0]!.tools?.map((tool) => tool.name)).toContain("SendMessage");
    expect(replay.replay.rounds[0]!.tools?.map((tool) => tool.name)).not.toContain("GatewayReply");
    const time = toolResultJson(replay.replay.rounds[1]!, "CurrentTime");
    expect(time.epochMs).toBeGreaterThanOrEqual(before);
    expect(time.epochMs).toBeLessThanOrEqual(Date.now());
    expect(
      toolResults(replay.events).find((entry) => entry.id === "raw-channel-rejected"),
    ).toMatchObject({ isError: true });
    expect(
      toolResults(replay.events).find((entry) => entry.id === "authorized-target")?.result,
    ).toContain("REQUEST_RECORDED_NOT_DELIVERED");
    expect(result.extensions?.pet).toEqual({
      hostActions: [
        {
          kind: "outboundMessage",
          payload: { targetId: "owner-wechat-7ac291", text: outboundText },
        },
      ],
    });
    expect(result.petWorkDelegation).toBeUndefined();
    expect(result.text).toBe("");
  });

  test("records the explicit interview-question preference without adding an unfinished tail or unrelated remote action", async () => {
    const preference = "以后面试题先给我题目";
    const replay = createReplay((_options, round) =>
      round === 1
        ? // The historical input trails off after “然后再加”. The scripted
          // request carries only its explicit stable preference, with no guessed
          // answer/review format or unrelated mobile-remote request.
          call("Memory", { action: "remember", text: preference })
        : call("GatewayReply", { text: "后面还想加什么？" }),
    );
    const result = await replay.run("记一下 以后面试题先给我题目然后再加", {
      hostActions: ["memory", "mobileRemote", "gatewayReply"],
    });

    expect(replay.replay.rounds).toHaveLength(2);
    expect(replay.replay.rounds[0]!.tools?.map((tool) => tool.name)).toContain("Memory");
    expect(replay.replay.rounds[0]!.tools?.map((tool) => tool.name)).toContain("MobileRemote");
    expect(JSON.stringify(replay.replay.rounds[0]!.messages)).toContain(
      "记一下 以后面试题先给我题目然后再加",
    );
    expect(toolResults(replay.events).map((entry) => entry.toolName)).toEqual([
      "Memory",
      "GatewayReply",
    ]);
    expect(result.extensions?.pet).toEqual({
      hostActions: [
        { kind: "memory", payload: { action: "remember", text: preference } },
        { kind: "gatewayReply", payload: { text: "后面还想加什么？" } },
      ],
    });
    expect(result.petWorkDelegation).toBeUndefined();
  });

  test("records open-remote intent without a fabricated tunnel address or delegated work", async () => {
    const replay = createReplay((_options, round) =>
      round === 1 ? call("MobileRemote", { action: "open" }) : { text: "", toolCalls: [] },
    );
    const result = await replay.run("打开远程遥控", {
      hostActions: ["mobileRemote", "gatewayReply"],
    });

    expect(replay.replay.rounds).toHaveLength(2);
    expect(toolResults(replay.events)).toHaveLength(1);
    expect(toolResults(replay.events)[0]?.result).toContain("after this turn");
    expect(toolResults(replay.events)[0]?.result).toContain("passcode");
    expect(result.extensions?.pet).toEqual({
      hostActions: [
        {
          kind: "mobileRemote",
          payload: { action: "open" },
        },
      ],
    });
    expect(result.petWorkDelegation).toBeUndefined();
    expect(result.text).toBe("");
  });

  test("records a completion watch with the exact runtime Session id and keeps acceptance distinct from activation", async () => {
    const activeSessionId = "work-active-482";
    const replay = createReplay((options, round) => {
      if (round === 1) {
        const context = JSON.parse(
          options.systemPrompt.split("<pet-world>")[1]!.split("</pet-world>")[0]!,
        );
        return call("WatchSession", { session_id: context.sessions[0].agentSessionId });
      }
      return call("GatewayReply", { text: "已请求登记这个会话的完成通知，等待宿主确认。" });
    });
    const result = await replay.run("有什么进度通知我", {
      hostActions: ["sessionWatch", "gatewayReply"],
      runtimeContext: JSON.stringify({
        currentMessageSource: { kind: "gateway", channel: "wechat" },
        sessions: [{ agentSessionId: activeSessionId, title: "正在整理面试题", phase: "running" }],
      }),
    });

    expect(replay.replay.rounds).toHaveLength(2);
    const watch = toolResults(replay.events).find((entry) => entry.toolName === "WatchSession");
    expect(watch).toMatchObject({ isError: false });
    expect(watch?.result).toContain("host validation after this turn");
    expect(watch?.result).toContain("until the host confirms");
    expect(result.extensions?.pet).toEqual({
      hostActions: [
        { kind: "sessionWatch", payload: { sessionId: activeSessionId } },
        { kind: "gatewayReply", payload: { text: "已请求登记这个会话的完成通知，等待宿主确认。" } },
      ],
    });
    expect(result.petWorkDelegation).toBeUndefined();
  });

  test("refreshes non-durable status without losing earlier user constraints or re-delegating a complaint", async () => {
    const replay = createReplay((_options, round) =>
      call("GatewayReply", {
        text:
          round === 1
            ? "明白，后续继续原会话，仍然只整理说明。"
            : "发布准备已暂停，等你确认后再继续。",
      }),
    );
    await replay.run("为什么又新开？继续原会话，只整理说明，不发布", {
      runtimeContext: JSON.stringify({
        longTasks: { active: [{ taskId: "release-ledger", status: "running" }] },
      }),
    });
    const result = await replay.run("现在做到哪了", {
      runtimeContext: JSON.stringify({
        longTasks: { active: [{ taskId: "release-ledger", status: "paused" }] },
      }),
    });

    const latest = replay.replay.rounds[1]!;
    expect(latest.systemPrompt).toContain('"status":"paused"');
    expect(latest.systemPrompt).not.toContain('"status":"running"');
    expect(JSON.stringify(latest.messages)).toContain("只整理说明，不发布");
    expect(JSON.stringify(latest.messages)).not.toContain("release-ledger");
    expect(result.petWorkDelegation).toBeUndefined();
    expect(result.extensions?.pet).toEqual({
      hostActions: [
        {
          kind: "gatewayReply",
          payload: { text: "发布准备已暂停，等你确认后再继续。" },
        },
      ],
    });
    expect(
      readFileSync(join(replay.sessionsRootDir, "mimi-replay", "transcript.jsonl"), "utf8"),
    ).not.toContain("release-ledger");
  });

  test.each(["wrong workspace", "invalid follow-up lookup"])(
    "bounds an uncooperative model that repeatedly attempts %s without dispatching work",
    async (failure) => {
      const replay = createReplay((_options, round) =>
        failure === "wrong workspace"
          ? call(
              "DelegateWork",
              {
                workspace_id: "ws-no-workspace",
                session_id: sessionSelectorId("work-release"),
                objective: "继续原会话",
              },
              `rejected-${round}`,
            )
          : call("FollowUps", { action: "get", query: "/" }, `rejected-${round}`),
      );
      const result = await replay.run("继续刚才那个");

      expect(PET_BEHAVIOR_PROFILE.maxTurns).toBe(6);
      expect(replay.replay.rounds).toHaveLength(6);
      expect(replay.replay.summaries).toHaveLength(1);
      expect(replay.replay.summaries[0]!.tools ?? []).toHaveLength(0);
      expect(result.reason).toBe("max_turns");
      expect(result.petWorkDelegation).toBeUndefined();
      expect(result.extensions?.pet).not.toHaveProperty("hostActions");
      expect(toolResults(replay.events)).toHaveLength(6);
      expect(toolResults(replay.events).every((entry) => entry.isError)).toBe(true);
    },
  );
});
