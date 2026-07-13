import { describe, expect, test } from "bun:test";
import {
  canExecuteCommandWhileRunning,
  dispatchSlashCommandSafely,
  goalEventMatchesActive,
  goalUpdateResponseIsFresh,
  shouldSuppressCancelledMainStreamEvent,
} from "./App.js";
import type { CommandContext } from "../cli/commands/registry.js";

describe("dispatchSlashCommandSafely", () => {
  test("reports async command failures as status text", async () => {
    const statuses: string[] = [];
    const registry = {
      dispatch: () => Promise.reject(new Error("boom")),
    };

    dispatchSlashCommandSafely(registry, "/explode", {} as CommandContext, (status) =>
      statuses.push(status),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(statuses).toEqual(["Command failed: boom"]);
  });
});

describe("running slash controls", () => {
  test.each([
    "/sid",
    "/help",
    "/goal",
    "/goal edit 新目标",
    "/goal pause",
    "/goal resume",
    "/goal delete",
    "/goal clear",
  ])("executes %s immediately", (input) => {
    expect(canExecuteCommandWhileRunning(input)).toBe(true);
  });

  test.each([
    "/goal edit",
    "/goal pause extra",
    "/goal resume extra",
    "/goal delete extra",
    "/goal clear extra",
    "/goal off extra",
    "/goal stop extra",
  ])("executes malformed control %s immediately so it can report usage", (input) => {
    expect(canExecuteCommandWhileRunning(input)).toBe(true);
  });

  test.each(["普通输入", "/model", "/goal 新目标", "/goal pause-worthy 目标", "/goal delete-plan"])(
    "queues %s",
    (input) => {
      expect(canExecuteCommandWhileRunning(input)).toBe(false);
    },
  );
});

describe("goal lifecycle revision fence", () => {
  test("matches only the current id and revision", () => {
    expect(goalEventMatchesActive("g", 3, "g", 3)).toBe(true);
    expect(goalEventMatchesActive("g", 3, "g", 2)).toBe(false);
    expect(goalEventMatchesActive("g", 3, "other", 3)).toBe(false);
    expect(goalEventMatchesActive("g", 3, "g", undefined)).toBe(false);
  });

  test("keeps legacy events compatible only with legacy mirrored state", () => {
    expect(goalEventMatchesActive(null, null, undefined, undefined)).toBe(true);
    expect(goalEventMatchesActive("g", null, "g", undefined)).toBe(true);
  });

  test("does not let a stale mutation response overwrite a newer event", () => {
    expect(goalUpdateResponseIsFresh("g", 3, "g", 2)).toBe(false);
    expect(goalUpdateResponseIsFresh("g", 3, "g", 3)).toBe(true);
    expect(goalUpdateResponseIsFresh("g", 3, "other", 4)).toBe(false);
    expect(goalUpdateResponseIsFresh(null, null, "g", 2)).toBe(false);
  });
});

describe("cancelled stream presentation fence", () => {
  test("suppresses late main-run presentation but keeps lifecycle reconciliation", () => {
    expect(shouldSuppressCancelledMainStreamEvent(true, { type: "text_delta", text: "late" })).toBe(
      true,
    );
    expect(
      shouldSuppressCancelledMainStreamEvent(true, { type: "error", error: "late error" }),
    ).toBe(true);
    expect(
      shouldSuppressCancelledMainStreamEvent(true, {
        type: "turn_complete",
        reason: "aborted_streaming",
      }),
    ).toBe(false);
    expect(
      shouldSuppressCancelledMainStreamEvent(true, {
        type: "goal_updated",
        goalId: "g",
        revision: 2,
        objective: "goal",
        paused: true,
      }),
    ).toBe(false);
    expect(
      shouldSuppressCancelledMainStreamEvent(true, {
        type: "text_delta",
        text: "child",
        agentId: "child",
      }),
    ).toBe(false);
  });
});
