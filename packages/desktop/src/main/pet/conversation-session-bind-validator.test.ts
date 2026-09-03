import { describe, expect, test } from "bun:test";
import { createConversationSessionBindValidator } from "./conversation-session-bind-validator.js";
import type { PetReusableSessionCandidate } from "./pet-dispatch-service.js";

const SELECTOR = "session-0123456789abcdef0123";

function candidate(
  overrides: Partial<PetReusableSessionCandidate> = {},
): PetReusableSessionCandidate {
  return {
    sessionId: "s-login",
    workspacePath: "/repo/project",
    title: "修复登录问题",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  } as PetReusableSessionCandidate;
}

function validator(
  resolved: PetReusableSessionCandidate | null,
  exists = true,
): ReturnType<typeof createConversationSessionBindValidator> {
  return createConversationSessionBindValidator({
    resolveSelector: async () => resolved,
    directoryExists: async () => exists,
  });
}

const DIRECT = { selector: SELECTOR, isDirectMessage: true, isAddressable: true };

describe("accepting a bind", () => {
  test("returns the resolved Session, not the model's wording", async () => {
    const result = await validator(candidate())(DIRECT);
    expect(result).toEqual({
      ok: true,
      candidate: {
        sessionId: "s-login",
        title: "修复登录问题",
        workspacePath: "/repo/project",
      },
    });
  });
});

describe("refusing a bind", () => {
  test("a selector the strict resolver rejects never binds", async () => {
    // The resolver folds unknown, archived and non-desktop origin into null;
    // all three must fail closed rather than fall back to a looser lookup.
    const result = await validator(null)(DIRECT);
    expect(result).toMatchObject({ ok: false, reason: "unknown-session" });
  });

  test("a Session whose workspace is gone is refused, not bound blindly", async () => {
    // A deleted worktree would otherwise accept messages into a path that no
    // longer exists and report a run that cannot happen.
    const result = await validator(candidate(), false)(DIRECT);
    expect(result).toMatchObject({ ok: false, reason: "workspace-missing" });
  });

  test("a Session with no workspace path at all is refused", async () => {
    const result = await validator(candidate({ workspacePath: "" }))(DIRECT);
    expect(result).toMatchObject({ ok: false, reason: "workspace-missing" });
  });

  test("a group chat is refused before any lookup happens", async () => {
    let looked = false;
    const validate = createConversationSessionBindValidator({
      resolveSelector: async () => {
        looked = true;
        return candidate();
      },
    });
    const result = await validate({ ...DIRECT, isDirectMessage: false });
    expect(result).toMatchObject({ ok: false, reason: "group-chat" });
    expect(looked).toBe(false);
  });

  test("an unaddressable conversation is refused", async () => {
    // petChatRouteKey fails closed without target/sender; binding such a
    // conversation could deliver replies to the wrong person.
    const result = await validator(candidate())({ ...DIRECT, isAddressable: false });
    expect(result).toMatchObject({ ok: false, reason: "unaddressable-conversation" });
  });

  test("every refusal carries a message the user can act on", async () => {
    const results = [
      await validator(null)(DIRECT),
      await validator(candidate(), false)(DIRECT),
      await validator(candidate())({ ...DIRECT, isDirectMessage: false }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(8);
    }
  });
});
