import { describe, expect, test } from "bun:test";
import type {
  ProtocolObserverHost,
  ToolContext,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import { createPetModule } from "./capability.js";
import {
  PET_RULE_UPSERT_ACTION,
  parseNoticeRuleUpsert,
  type NoticeRuleUpsert,
  type NoticeRuleUpsertReply,
} from "./notice-rule.js";
import {
  NOTIFY_ME_TOOL_NAME,
  notifyMeAvailability,
  notifyMeTool,
  notifyMeToolDef,
  type NoticeRuleHostRequester,
} from "./notify-me.js";
import { PET_ALLOWED_TOOL_NAMES } from "./profile.js";

const SESSION_ID = "work-806bb2404fc122889366de82";
const ROOT_ID = "work-11111111111111111111aaaa";

function visibility(overrides: Partial<ToolVisibilityContext> = {}): ToolVisibilityContext {
  return { cwd: "/work", hasGoal: false, sessionId: SESSION_ID, isSubAgent: false, ...overrides };
}

function context(options: { goal?: { paused?: boolean } | undefined } = {}): ToolContext {
  return {
    sessionId: SESSION_ID,
    engine: {
      planMode: false,
      setPlanMode: () => {},
      getSessionManager: () => ({
        readActiveGoal: (sessionId: string) =>
          sessionId === SESSION_ID && options.goal
            ? { objective: "ship", ...options.goal }
            : undefined,
      }),
    },
  } as unknown as ToolContext;
}

const OK_REPLY: NoticeRuleUpsertReply = {
  ok: true,
  status: "ok",
  effect: {
    ruleId: "rule-1",
    fires: "when this turn is done, fails or gets blocked",
    channel: "wechat",
    im: { channel: "wechat", label: "WeChat", ready: "ready" },
  },
};

function recorder(reply: unknown | (() => Promise<unknown>)) {
  const calls: Array<{ sessionId: string; action: string; args: Record<string, unknown> }> = [];
  const request: NoticeRuleHostRequester = async (sessionId, action, args) => {
    calls.push({ sessionId, action, args });
    return typeof reply === "function" ? (reply as () => Promise<unknown>)() : reply;
  };
  return { calls, request };
}

describe("NotifyMe visibility", () => {
  test("is visible to native top-level Sessions only", () => {
    expect(notifyMeAvailability(visibility())).toBe(true);
    expect(notifyMeAvailability(visibility({ hasGoal: true }))).toBe(true);
    // A sub-agent needs a trusted root Session id distinct from its own id;
    // otherwise it stays hidden rather than mis-attaching.
    expect(notifyMeAvailability(visibility({ isSubAgent: true }))).toBe(false);
    expect(notifyMeAvailability(visibility({ isSubAgent: true, rootSessionId: ROOT_ID }))).toBe(
      true,
    );
    expect(notifyMeAvailability(visibility({ isSubAgent: true, rootSessionId: SESSION_ID }))).toBe(
      false,
    );
    expect(notifyMeAvailability(visibility({ isSubAgent: true, rootSessionId: " bad " }))).toBe(
      false,
    );
    expect(
      notifyMeAvailability(
        visibility({ isSubAgent: true, rootSessionId: ROOT_ID, behaviorProfile: "pet" }),
      ),
    ).toBe(false);
    expect(notifyMeAvailability(visibility({ behaviorProfile: "pet" }))).toBe(false);
    expect(notifyMeAvailability(visibility({ sessionId: undefined }))).toBe(false);
    expect(notifyMeAvailability(visibility({ sessionId: " bad " }))).toBe(false);
  });

  test("is not part of Mimi's own tool allowlist", () => {
    expect(PET_ALLOWED_TOOL_NAMES.has(NOTIFY_ME_TOOL_NAME)).toBe(false);
  });

  test("describes when to use it and the channel mapping", () => {
    expect(notifyMeToolDef.description).toContain(
      "Use when the owner asks to be told when this Session is done, fails or gets blocked.",
    );
    expect(notifyMeToolDef.description).toContain(
      "set channel to that gateway channel id (wechat, wecom, lark, telegram, slack…)",
    );
    expect(notifyMeToolDef.description).toContain("WeCom/企业微信 → wecom");
    expect(notifyMeToolDef.description).toContain(
      "Call once; the host tracks completion — do not call RequestMimiDelivery at the end.",
    );
  });
});

describe("NotifyMe validation", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["empty when", { when: [] }, "when"],
    ["unknown event", { when: ["done", "started"] }, "when"],
    ["duplicate event", { when: ["done", "done"] }, "when"],
    ["non-array when", { when: "done" }, "when"],
    ["bad scope", { scope: "forever" }, "scope"],
    ["bad attention", { attention: "digest" }, "attention"],
    ["empty channel", { channel: "  " }, "channel"],
    ["long channel", { channel: "x".repeat(41) }, "channel"],
    ["non-string channel", { channel: 3 }, "channel"],
    ["long note", { note: "n".repeat(501) }, "note"],
    ["non-string note", { note: 1 }, "note"],
    ["unknown field", { recipient: "me" }, "accepts only"],
  ];
  for (const [name, args, needle] of cases) {
    test(`rejects ${name}`, async () => {
      const { calls, request } = recorder(OK_REPLY);
      const text = await notifyMeTool(args, context(), request);
      expect(text.startsWith("Error:")).toBe(true);
      expect(text).toContain(needle);
      expect(calls).toHaveLength(0);
    });
  }

  test("requires a valid current Session and a non-sub-agent context", async () => {
    const { calls, request } = recorder(OK_REPLY);
    await expect(
      notifyMeTool({}, { ...context(), sessionId: undefined } as ToolContext, request),
    ).resolves.toContain("valid current Session");
    await expect(
      notifyMeTool({}, { ...context(), isSubAgent: true } as ToolContext, request),
    ).resolves.toStartWith("Error:");
    await expect(
      notifyMeTool(
        {},
        { ...context(), isSubAgent: true, rootSessionId: SESSION_ID } as ToolContext,
        request,
      ),
    ).resolves.toStartWith("Error:");
    expect(calls).toHaveLength(0);
  });
});

describe("NotifyMe execution", () => {
  test("reports an unavailable host rule channel", async () => {
    await expect(notifyMeTool({}, context(), undefined)).resolves.toBe(
      "Error: the host rule channel is unavailable.",
    );
  });

  test("sends defaults as a notify-me NoticeRuleUpsert", async () => {
    const { calls, request } = recorder(OK_REPLY);
    await notifyMeTool({}, context(), request);
    expect(calls).toEqual([
      {
        sessionId: SESSION_ID,
        action: PET_RULE_UPSERT_ACTION,
        args: {
          sessionId: SESSION_ID,
          createdBy: "notify-me",
          events: ["done", "failed", "blocked"],
          scope: "turn",
          channel: "auto",
          attention: "always",
        } satisfies NoticeRuleUpsert,
      },
    ]);
  });

  test("a sub-agent files the rule on the root Session, including its Goal default", async () => {
    const subContext = (goal?: { paused?: boolean }): ToolContext =>
      ({
        ...context(),
        isSubAgent: true,
        rootSessionId: ROOT_ID,
        engine: {
          getSessionManager: () => ({
            readActiveGoal: (sessionId: string) =>
              sessionId === ROOT_ID && goal ? { objective: "ship", ...goal } : undefined,
          }),
        },
      }) as unknown as ToolContext;
    const turn = recorder(OK_REPLY);
    const text = await notifyMeTool({}, subContext(), turn.request);
    expect(turn.calls).toHaveLength(1);
    expect(turn.calls[0]!.sessionId).toBe(ROOT_ID);
    expect(turn.calls[0]!.args.sessionId).toBe(ROOT_ID);
    expect(turn.calls[0]!.args.scope).toBe("turn");
    expect(text).toContain("main Session");
    const goal = recorder(OK_REPLY);
    await notifyMeTool({}, subContext({}), goal.request);
    expect(goal.calls[0]!.args.scope).toBe("goal");
  });

  test("defaults scope to goal while the Session has an active, unpaused Goal", async () => {
    const active = recorder(OK_REPLY);
    await notifyMeTool({}, context({ goal: {} }), active.request);
    expect(active.calls[0]!.args.scope).toBe("goal");

    const paused = recorder(OK_REPLY);
    await notifyMeTool({}, context({ goal: { paused: true } }), paused.request);
    expect(paused.calls[0]!.args.scope).toBe("turn");

    const explicit = recorder(OK_REPLY);
    await notifyMeTool({ scope: "turn" }, context({ goal: {} }), explicit.request);
    expect(explicit.calls[0]!.args.scope).toBe("turn");
  });

  test("passes explicit arguments through, normalizing the channel id", async () => {
    const { calls, request } = recorder(OK_REPLY);
    await notifyMeTool(
      {
        when: ["failed", "blocked"],
        scope: "goal",
        channel: " WeChat ",
        attention: "important",
        note: " 顺便附上截图 ",
      },
      context(),
      request,
    );
    expect(calls[0]!.args).toEqual({
      sessionId: SESSION_ID,
      createdBy: "notify-me",
      events: ["failed", "blocked"],
      scope: "goal",
      channel: "wechat",
      attention: "important",
      note: "顺便附上截图",
    });
    expect(parseNoticeRuleUpsert(calls[0]!.args)).toEqual(calls[0]!.args as NoticeRuleUpsert);
  });

  test("summarizes the saved rule with the actual IM channel and readiness", async () => {
    const { request } = recorder({
      ...OK_REPLY,
      effect: { ...OK_REPLY.effect, quietHours: "23:00-08:00" },
    });
    const text = await notifyMeTool({ channel: "wechat" }, context(), request);
    expect(text).toContain("rule-1");
    expect(text).toContain("when this turn is done, fails or gets blocked");
    expect(text).toContain("WeChat");
    expect(text).toContain("ready");
    expect(text).toContain("23:00-08:00");
    expect(text).toContain("Tell the owner exactly this; do not claim anything was sent.");
  });

  test("an auto rule promises the IM only while the owner is away", async () => {
    const { request } = recorder({
      ...OK_REPLY,
      effect: { ...OK_REPLY.effect, channel: "auto" },
    });
    const text = await notifyMeTool({}, context(), request);
    expect(text).toContain(
      "via a desktop notification while the owner is at the computer, or WeChat (wechat, ready) while away.",
    );
  });

  test("summarizes a desktop rule", async () => {
    const { request } = recorder({
      ok: true,
      status: "ok",
      effect: { ruleId: "rule-2", fires: "when this goal ends", channel: "desktop" },
    });
    const text = await notifyMeTool({ channel: "desktop" }, context(), request);
    expect(text).toContain("rule-2");
    expect(text).toContain("desktop notification");
    expect(text).toContain("Tell the owner exactly this; do not claim anything was sent.");
  });

  test("lists bound channels when the host does not know the channel id", async () => {
    const { request } = recorder({
      ok: true,
      status: "unknown_channel",
      channels: [
        { id: "wechat", label: "WeChat", ready: "unknown" },
        { id: "lark", label: "Feishu", ready: "ready" },
      ],
    });
    const text = await notifyMeTool({ channel: "weixin" }, context(), request);
    expect(text).toContain("weixin");
    expect(text).toContain("wechat");
    expect(text).toContain("WeChat");
    expect(text).toContain("unknown");
    expect(text).toContain("lark");
    expect(text).toContain("Feishu");
    expect(text).toContain("ready");
    expect(text).toContain("Pick one of these ids, or tell the owner which channels are bound.");
    expect(text).not.toContain("Tell the owner exactly this");
  });

  test("reports a host rejection as not set up", async () => {
    const { request } = recorder(async () => {
      throw new Error("rule store is locked");
    });
    await expect(notifyMeTool({}, context(), request)).resolves.toBe(
      "Error: the notice rule was not saved (rule store is locked). Tell the owner it is not set up.",
    );
  });

  test("collapses and bounds the host error reason before it reaches the model", async () => {
    const { request } = recorder(async () => {
      throw new Error(`disk\n\tfull\u0007  ${"x".repeat(400)}`);
    });
    const text = await notifyMeTool({}, context(), request);
    const reason = text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"));
    expect(reason.startsWith("disk full x")).toBe(true);
    expect(reason.length).toBe(200);
    expect(reason.endsWith("…")).toBe(true);
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(text).toEndWith("Tell the owner it is not set up.");
  });

  test("treats a malformed host reply as not saved", async () => {
    const { request } = recorder({ ok: true, status: "ok" });
    await expect(notifyMeTool({}, context(), request)).resolves.toContain(
      "Error: the notice rule was not saved (",
    );
  });
});

describe("NotifyMe registration", () => {
  function host(
    overrides: Partial<ProtocolObserverHost> = {},
  ): ProtocolObserverHost & { requests: unknown[] } {
    const requests: unknown[] = [];
    return {
      requests,
      getLiveSessionSnapshot: () => [],
      projectionGeneration: () => 1,
      getSessionKind: () => undefined,
      isTransportDisconnected: () => false,
      notify: () => {},
      registerQuery: () => () => {},
      requestHostAction: async (sessionId, action, args) => {
        requests.push({ sessionId, action, args });
        return OK_REPLY;
      },
      ...overrides,
    };
  }

  function toolOf(module_: ReturnType<typeof createPetModule>) {
    return module_
      .engine!.tools!.flatMap((c) => (c.kind === "preset-tags" ? [c.tool] : []))
      .find((c) => c.definition.name === NOTIFY_ME_TOOL_NAME)!;
  }

  test("is allowed by default and routed through the attached host", async () => {
    const module_ = createPetModule();
    const tool = toolOf(module_);
    expect(tool.definition.permissionDefault).toBe("allow");
    expect(tool.exposure.defaultPermissionRules).toEqual([
      { tool: NOTIFY_ME_TOOL_NAME, decision: "allow" },
    ]);
    expect(tool.exposure.presetTags).toEqual(["harness-min", "general"]);
    expect(tool.exposure.availability?.(visibility())).toBe(true);

    const observerHost = host();
    const observer = module_.protocol!.createObserver!(observerHost);
    observer.onSessionAttached?.(SESSION_ID, 1);
    const text = await tool.execute({}, context());
    expect(text).toContain("rule-1");
    expect(observerHost.requests).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, action: PET_RULE_UPSERT_ACTION }),
    ]);

    observer.onServerClose?.();
    await expect(tool.execute({}, context())).resolves.toBe(
      "Error: the host rule channel is unavailable.",
    );
  });

  test("a sub-agent is routed on its root Session id, never its own", async () => {
    const module_ = createPetModule();
    const tool = toolOf(module_);
    const observerHost = host();
    const observer = module_.protocol!.createObserver!(observerHost);
    observer.onSessionAttached?.(ROOT_ID, 1);
    const child = {
      ...context(),
      isSubAgent: true,
      rootSessionId: ROOT_ID,
    } as ToolContext;
    expect(await tool.execute({}, child)).toContain("rule-1");
    expect(observerHost.requests).toEqual([
      expect.objectContaining({ sessionId: ROOT_ID, action: PET_RULE_UPSERT_ACTION }),
    ]);
    // Missing root: fails closed without touching the host.
    const orphan = { ...context(), isSubAgent: true } as ToolContext;
    expect(await tool.execute({}, orphan)).toStartWith("Error:");
    expect(observerHost.requests).toHaveLength(1);
    observer.onServerClose?.();
  });

  test("is unavailable on a host without the action loopback", async () => {
    const module_ = createPetModule();
    const tool = toolOf(module_);
    const observer = module_.protocol!.createObserver!(host({ requestHostAction: undefined }));
    observer.onSessionAttached?.(SESSION_ID, 1);
    await expect(tool.execute({}, context())).resolves.toBe(
      "Error: the host rule channel is unavailable.",
    );
    observer.onServerClose?.();
  });
});

describe("bookkeeping tools", () => {
  test("only the tools that talk to the owner or Mimi are declared as not work", () => {
    // Core reads this flag for turn_complete.outcome.didWork: a turn that only
    // arranged a notice or reported to Mimi must not count as finished work.
    const bookkeeping = (createPetModule().engine?.tools ?? [])
      .filter(({ tool }) => tool.definition.bookkeeping === true)
      .map(({ tool }) => tool.definition.name)
      .sort();
    expect(bookkeeping).toEqual([NOTIFY_ME_TOOL_NAME, "ReportToMimi", "RequestMimiDelivery"]);
  });
});
