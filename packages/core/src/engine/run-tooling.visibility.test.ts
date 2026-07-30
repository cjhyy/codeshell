/**
 * `toolVisibility` is what the ToolExecutor's availability guards read, and it
 * gates BOTH what the model is shown and what the executor will run: a guarded
 * builtin whose guard fails is rejected before its handler, not merely hidden
 * (executor.ts's visibility gate).
 *
 * Building it used to be an inline block inside assembleRunToolDefs — one of 21
 * parameters' worth of Engine-run state. Any second caller that assembles a tool
 * surface without an Engine run (a session-scoped tool host exposing tools to an
 * external Agent Runtime) would either duplicate the block and drift, or leave
 * the field undefined. Undefined is the dangerous outcome: the executor's guard
 * check is skipped when `toolCtx.toolVisibility` is absent, so a host-gated tool
 * like Panel would become callable in a context its guard was written to exclude.
 *
 * These tests pin the builder as an independently-callable unit.
 */
import { describe, expect, test } from "bun:test";
import { buildToolVisibility } from "./run-tooling.js";

describe("buildToolVisibility", () => {
  test("carries the fields availability guards actually branch on", () => {
    const visibility = buildToolVisibility({
      cwd: "/repo",
      hasGoal: true,
      settingsScope: "project",
      host: "desktop",
      isSubAgent: false,
      behaviorProfile: "coding",
    });

    // Panel's guard is `ctx.host === "desktop" && ctx.isSubAgent !== true`.
    expect(visibility.host).toBe("desktop");
    expect(visibility.isSubAgent).toBe(false);
    expect(visibility.cwd).toBe("/repo");
    expect(visibility.hasGoal).toBe(true);
    expect(visibility.settingsScope).toBe("project");
    expect(visibility.behaviorProfile).toBe("coding");
  });

  test("omits optional keys rather than setting them undefined", () => {
    const visibility = buildToolVisibility({ cwd: "/repo", hasGoal: false });

    // Guards use `!== true` / `?? []` style checks, and snapshots of this object
    // reach persistence; absent keys must stay absent rather than serialize null.
    expect("sessionId" in visibility).toBe(false);
    expect("profileMeta" in visibility).toBe(false);
    expect("sessionMessageTargets" in visibility).toBe(false);
    expect(visibility).toEqual({ cwd: "/repo", hasGoal: false });
  });

  test("includes sessionId and profileMeta only when supplied", () => {
    const visibility = buildToolVisibility({
      cwd: "/repo",
      hasGoal: false,
      sessionId: "sess-1",
      profileMeta: { reviewMode: "strict" },
    });

    expect(visibility.sessionId).toBe("sess-1");
    expect(visibility.profileMeta).toEqual({ reviewMode: "strict" });
  });

  test("drops an empty session-message target list", () => {
    // SendMessageToSession's guard is `(targets?.length ?? 0) > 0`; an empty
    // array must not be carried as if the host had authorized targets.
    const empty = buildToolVisibility({ cwd: "/repo", hasGoal: false, sessionMessageTargets: [] });
    expect("sessionMessageTargets" in empty).toBe(false);

    const populated = buildToolVisibility({
      cwd: "/repo",
      hasGoal: false,
      sessionMessageTargets: [{ sessionId: "peer", title: "Peer" } as never],
    });
    expect(populated.sessionMessageTargets).toHaveLength(1);
  });
});
