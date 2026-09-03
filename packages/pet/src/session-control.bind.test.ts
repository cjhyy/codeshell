import { describe, expect, test } from "bun:test";
import type { ToolContext, ToolVisibilityContext } from "@cjhyy/code-shell-core/extension";
import {
  BIND_CONVERSATION_SESSION_TOOL_NAME,
  bindConversationSessionAvailability,
  bindConversationSessionTool,
  bindConversationSessionToolDef,
} from "./session-control.js";
import { PET_ALLOWED_TOOL_NAMES, PET_SYSTEM_PROMPT } from "./profile.js";
import { PET_HOST_ACTION_KINDS } from "./host-actions.js";

const VALID_SELECTOR = "session-0123456789abcdef0123";

interface Recorded {
  kind: string;
  payload: Record<string, unknown>;
}

function context(
  decide: (request: Recorded) => { ok: boolean; error?: string } = () => ({ ok: true }),
): { ctx: ToolContext; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const ctx = {
    runScopedServices: {
      requestPetHostAction: (request: Recorded) => {
        requests.push(request);
        return decide(request);
      },
    },
  } as unknown as ToolContext;
  return { ctx, requests };
}

describe("BindConversationSession wiring", () => {
  test("is a declared host action kind and an allowed Mimi tool", () => {
    expect(PET_HOST_ACTION_KINDS).toContain("sessionBind");
    expect(PET_ALLOWED_TOOL_NAMES.has(BIND_CONVERSATION_SESSION_TOOL_NAME)).toBe(true);
  });

  test("is visible only when the host declared it for this turn", () => {
    // Same posture as sessionWatch: a turn without the host wiring must not
    // expose a permanently-broken tool.
    const visible = {
      behaviorProfile: "pet",
      profileMeta: { petHostActionKinds: ["sessionBind"] },
    };
    const hidden = {
      behaviorProfile: "pet",
      profileMeta: { petHostActionKinds: ["gatewayReply"] },
    };
    // A non-pet profile never sees it even when the host declared the kind.
    const notPet = {
      behaviorProfile: "default",
      profileMeta: { petHostActionKinds: ["sessionBind"] },
    };
    expect(bindConversationSessionAvailability(visible as unknown as ToolVisibilityContext)).toBe(
      true,
    );
    expect(bindConversationSessionAvailability(hidden as unknown as ToolVisibilityContext)).toBe(
      false,
    );
    expect(bindConversationSessionAvailability(notPet as unknown as ToolVisibilityContext)).toBe(
      false,
    );
  });

  test("the schema accepts no argument beyond action and session_selector", () => {
    const schema = bindConversationSessionToolDef.inputSchema as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(["action", "session_selector"]);
  });

  test("the prompt tells Mimi entering is routing, not completion or delegation", () => {
    expect(PET_SYSTEM_PROMPT).toContain(BIND_CONVERSATION_SESSION_TOOL_NAME);
    expect(PET_SYSTEM_PROMPT).toContain("never creates a Session or a task");
    expect(PET_SYSTEM_PROMPT).toContain("Never guess a selector");
  });
});

describe("enter", () => {
  test("records the request without claiming the conversation entered", () => {
    const { ctx, requests } = context();
    return bindConversationSessionTool(
      { action: "enter", session_selector: VALID_SELECTOR },
      ctx,
    ).then((result) => {
      expect(requests).toEqual([
        { kind: "sessionBind", payload: { action: "enter", sessionSelector: VALID_SELECTOR } },
      ]);
      expect(result).toContain("accepted for host validation");
      expect(result).not.toContain("Error");
    });
  });

  test("rejects a title, path, or raw session id in place of a selector", async () => {
    const { ctx, requests } = context();
    for (const bad of [
      "修复登录问题",
      "/Users/me/code/project",
      "s-login-fix",
      "session-SHORT",
      "session-0123456789abcdef012g",
      `${VALID_SELECTOR} `.repeat(20),
    ]) {
      const result = await bindConversationSessionTool(
        { action: "enter", session_selector: bad },
        ctx,
      );
      expect(result).toStartWith("Error:");
    }
    // Nothing reached the host: a malformed selector cannot become a bind.
    expect(requests).toEqual([]);
  });

  test("requires a selector to enter", async () => {
    const { ctx, requests } = context();
    expect(await bindConversationSessionTool({ action: "enter" }, ctx)).toStartWith("Error:");
    expect(requests).toEqual([]);
  });

  test("relays the host's refusal instead of inventing success", async () => {
    const { ctx } = context(() => ({ ok: false, error: "that Session is archived" }));
    const result = await bindConversationSessionTool(
      { action: "enter", session_selector: VALID_SELECTOR },
      ctx,
    );
    expect(result).toBe("Error: that Session is archived");
  });
});

describe("leave", () => {
  test("records a leave with no selector", async () => {
    const { ctx, requests } = context();
    const result = await bindConversationSessionTool({ action: "leave" }, ctx);
    expect(requests).toEqual([{ kind: "sessionBind", payload: { action: "leave" } }]);
    expect(result).toContain("accepted for host validation");
  });

  test("refuses a leave that also names a Session", async () => {
    const { ctx, requests } = context();
    const result = await bindConversationSessionTool(
      { action: "leave", session_selector: VALID_SELECTOR },
      ctx,
    );
    expect(result).toStartWith("Error:");
    expect(requests).toEqual([]);
  });
});

describe("fail closed", () => {
  test("is unusable outside a turn with the host action service", async () => {
    const result = await bindConversationSessionTool({
      action: "enter",
      session_selector: VALID_SELECTOR,
    });
    expect(result).toContain("only in an IM-originated Mimi turn");
  });

  test("rejects an unknown action and undeclared arguments", async () => {
    const { ctx, requests } = context();
    expect(await bindConversationSessionTool({ action: "resume" }, ctx)).toStartWith("Error:");
    expect(
      await bindConversationSessionTool(
        { action: "enter", session_selector: VALID_SELECTOR, force: true },
        ctx,
      ),
    ).toStartWith("Error:");
    expect(requests).toEqual([]);
  });
});
