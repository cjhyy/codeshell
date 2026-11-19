import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoalAttentionState } from "../external-runtime-goal-attention.js";
import {
  createGoalNoticeReconciler,
  GOAL_NOTICE_MAX_AGE_MS,
  persistedBlockedOutcome,
  recentSessionIds,
} from "./pet-notice-goal-reconcile.js";
import { goalPauseDedupeKey } from "./pet-session-rule-watcher.js";
import {
  createExternalSessionCatalog,
  type ExternalRuntimeNoticeProbe,
  type PersistedExternalSessionState,
} from "./pet-notice-external-sessions.js";

function catalog(
  live: Record<string, ReturnType<ExternalRuntimeNoticeProbe["noticeProbe"]>> = {},
  persisted: Record<string, PersistedExternalSessionState> = {},
  runtime: "present" | "absent" | "throws" = "present",
) {
  const reads: string[] = [];
  const probe: ExternalRuntimeNoticeProbe = { noticeProbe: (id) => live[id] };
  return {
    reads,
    catalog: createExternalSessionCatalog({
      runtime: () => {
        if (runtime === "throws") throw new Error("service gone");
        return runtime === "present" ? probe : null;
      },
      readState: (id) => {
        reads.push(id);
        if (id === "broken") throw new Error("corrupt state.json");
        return persisted[id];
      },
    }),
  };
}

const probe = (queuedAtTerminal = 0) => ({ queuedAtTerminal });

const codexState: PersistedExternalSessionState = {
  provider: "codex",
  model: "gpt-5",
  title: "修登录",
  summary: "帮我修登录",
};

describe("external Session catalog", () => {
  test("a live runtime is known with its title and queue", () => {
    const { catalog: known } = catalog({ "s-codex": probe(1) }, { "s-codex": codexState });
    expect(known.get("s-codex")).toEqual({ sessionId: "s-codex", title: "修登录", busy: true });
    expect(known.has("s-codex")).toBe(true);
    expect(known.isLive("s-codex")).toBe(true);
  });

  test("busy is the queue sampled at the last terminal: a running turn alone is not busy", () => {
    const { catalog: known } = catalog({ "s-cc": probe(0) });
    expect(known.get("s-cc")).toEqual({ sessionId: "s-cc", busy: false });
  });

  test("isLive asks the runtime only, never the persisted state", () => {
    const { catalog: known, reads } = catalog({ live: probe() }, { idle: codexState });
    expect([known.isLive("live"), known.isLive("idle"), known.isLive("missing")]).toEqual([
      true,
      false,
      false,
    ]);
    expect(reads).toEqual([]);
    for (const runtime of ["absent", "throws"] as const)
      expect(catalog({ live: probe() }, {}, runtime).catalog.isLive("live")).toBe(false);
  });

  test("the title falls back to the first-message summary", () => {
    const { catalog: known } = catalog({ s: probe() }, { s: { ...codexState, title: "  " } });
    expect(known.get("s")?.title).toBe("帮我修登录");
  });

  test("a persisted external work Session without a runtime is known, not busy", () => {
    const { catalog: known } = catalog(
      {},
      {
        "s-codex": codexState,
        // An unknown provider whose model key names the runtime.
        "s-keyed": { provider: "legacy-runtime", model: "claude-code/opus" },
      },
    );
    expect(known.get("s-codex")).toEqual({ sessionId: "s-codex", title: "修登录", busy: false });
    expect(known.has("s-keyed")).toBe(true);
    expect(known.isLive("s-codex")).toBe(false);
  });

  const excluded: Record<string, PersistedExternalSessionState> = {
    child: { ...codexState, parentSessionId: "s-parent" },
    subagent: { ...codexState, origin: "subagent" },
    ephemeral: { ...codexState, ephemeral: true },
    archived: { ...codexState, archivedAt: 1 },
    pet: { ...codexState, kind: "pet" },
    hidden: { ...codexState, kind: "automation" },
  };

  test("native, sub-agent, child, ephemeral, archived, non-work and unknown are not external", () => {
    const { catalog: known } = catalog(
      {},
      {
        native: { provider: "anthropic", model: "claude-opus" },
        // A native provider wins over a model key that looks external.
        nativeKeyed: { provider: "anthropic", model: "codex/gpt-5" },
        ...excluded,
      },
    );
    for (const id of ["native", "nativeKeyed", ...Object.keys(excluded), "missing", "broken"])
      expect(known.get(id)).toBeUndefined();
    expect(known.has("missing")).toBe(false);
  });

  test("a live runtime of a Session that is not top-level work is not eligible either", () => {
    const live = Object.fromEntries(Object.keys(excluded).map((id) => [id, probe()]));
    const { catalog: known } = catalog(live, excluded);
    for (const id of Object.keys(excluded)) expect(known.has(id)).toBe(false);
  });

  test("a non-numeric archivedAt does not archive (as core reads it)", () => {
    const { catalog: known } = catalog({}, { s: { ...codexState, archivedAt: null } });
    expect(known.has("s")).toBe(true);
  });

  test("an explicit top-level work Session is external", () => {
    const { catalog: known } = catalog(
      {},
      { s: { ...codexState, kind: "work", parentSessionId: null } },
    );
    expect(known.has("s")).toBe(true);
  });

  test("a live runtime wins over a persisted native provider; identity is still checked", () => {
    const { catalog: known, reads } = catalog(
      { s: probe() },
      { s: { provider: "anthropic", model: "x" } },
    );
    expect(known.has("s")).toBe(true);
    // One read: the identity filter and the title share it.
    expect(reads).toEqual(["s"]);
  });

  test("without the runtime service, only persisted Sessions are known", () => {
    for (const runtime of ["absent", "throws"] as const) {
      const { catalog: known } = catalog({ s: probe(2) }, { s: codexState }, runtime);
      expect(known.get("s")).toMatchObject({ busy: false });
    }
  });
});

describe("persisted Goal notices", () => {
  const NOW = 1_800_000_000_000;
  const base = { version: 1 as const, goalId: "g-1", revision: 3, config: { objective: "迁移" } };
  const limited = (updatedAtMs = NOW - 60_000): GoalAttentionState => ({
    runId: "run-latest",
    goalLifecycle: {
      ...base,
      phase: "paused",
      pauseReason: "no_progress",
      runId: "run-paused",
      updatedAtMs,
    },
  });
  const asking = (question?: { text: string; detail?: Record<string, unknown> }) =>
    ({
      runId: "run-ask",
      goalLifecycle: {
        ...base,
        phase: "waiting",
        waitKind: "user",
        waitingFor: "finite_background_work",
        waitingSinceMs: NOW - 60_000,
        updatedAtMs: NOW - 60_000,
        ...(question ? { question } : {}),
      },
    }) satisfies GoalAttentionState;
  const active: GoalAttentionState = {
    runId: "run-latest",
    goalLifecycle: { ...base, phase: "active", updatedAtMs: NOW },
  };

  function reconciler(
    states: Record<string, GoalAttentionState | undefined>,
    options: {
      running?: string[];
      waiting?: string[];
      reported?: string[];
      native?: string[];
    } = {},
  ) {
    const reported: string[] = [];
    const withdrawn: string[] = [];
    const reconcile = createGoalNoticeReconciler({
      source: {
        recentSessions: async () => Object.keys(states),
        readState: (id) => states[id],
        isRunning: (id) => options.running?.includes(id) === true,
      },
      isExternalSession: (id) => !options.native?.includes(id),
      isReported: (outcome) => options.reported?.includes(goalPauseDedupeKey(outcome)) === true,
      report: async (outcome) => void reported.push(goalPauseDedupeKey(outcome)),
      waitingSessions: () => options.waiting ?? [],
      withdraw: async (id) => void withdrawn.push(id),
      now: () => NOW,
      log: () => undefined,
    });
    return { reconcile, reported, withdrawn };
  }

  test("a limit pause and an open question are stated as their live outcomes were", () => {
    const pause = persistedBlockedOutcome("s", {
      kind: "limit",
      limit: "no_progress",
      goalId: "g-1",
      revision: 3,
      runId: "run-paused",
      atMs: NOW,
    })!;
    expect(pause).toMatchObject({
      kind: "blocked",
      reason: "limit",
      limit: "no_progress",
      runKey: "run-paused",
      at: NOW,
      final: true,
    });
    // As the live closing outcome: its key names the run, not the Goal version.
    expect(goalPauseDedupeKey(pause)).toBe("s:goal-pause:-:-:run-paused");

    const question = {
      text: "迁移前要先定两件事。",
      level: "preference" as const,
      questions: [
        {
          id: "db",
          question: "用哪个数据库？",
          options: [{ label: "Postgres" }, { label: "SQLite" }],
        },
        { id: "when", question: "何时切换？", options: [{ label: "今晚" }, { label: "周末" }] },
      ],
    };
    const asked = persistedBlockedOutcome("s", {
      kind: "question",
      question,
      goalId: "g-1",
      revision: 3,
      runId: "run-ask",
      atMs: NOW,
    })!;
    expect(asked).toMatchObject({ kind: "blocked", reason: "user", goalId: "g-1", revision: 3 });
    // Several questions cannot be answered by one tap: they are spelled out instead.
    expect(asked.question).toContain("何时切换？");
    expect(asked).not.toHaveProperty("options");
    expect(goalPauseDedupeKey(asked)).toBe("s:goal-pause:g-1:3:run-ask");
  });

  test("each stopped Goal is reported once; known, running, foreign and stale ones are left alone", async () => {
    const states = {
      paused: limited(),
      asking: asking({ text: "用哪个数据库？", detail: { level: "preference" } }),
      known: limited(),
      running: limited(),
      native: limited(),
      old: limited(NOW - GOAL_NOTICE_MAX_AGE_MS - 1),
      unasked: asking(),
      unreadable: undefined,
    };
    const { reconcile, reported, withdrawn } = reconciler(states, {
      running: ["running"],
      native: ["native"],
      reported: ["known:goal-pause:-:-:run-paused"],
      // Still stopped: a waiting notice about each of these stays.
      waiting: ["paused", "unasked", "unreadable", "running", "native"],
    });
    await reconcile.all();
    expect(reported).toEqual([
      "paused:goal-pause:-:-:run-paused",
      "asking:goal-pause:g-1:3:run-ask",
    ]);
    expect(withdrawn).toEqual([]);
  });

  test("a Goal that moved on has its waiting notice withdrawn, and only then", async () => {
    const { reconcile, reported, withdrawn } = reconciler(
      { resumed: active, quiet: active, cleared: { runId: "run-latest" } },
      { waiting: ["resumed", "cleared", "gone"] },
    );
    // `gone` is not among the recent Sessions: a waiting notice alone brings it in.
    await reconcile.all();
    await reconcile.session("quiet");
    expect(reported).toEqual([]);
    expect(withdrawn).toEqual(["resumed", "cleared"]);
  });

  test("recent Sessions are found by their state file's time", async () => {
    const root = mkdtempSync(join(tmpdir(), "goal-notice-sessions-"));
    try {
      const write = (name: string, ageMs: number) => {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, "state.json"), "{}");
        const at = new Date(Date.now() - ageMs);
        utimesSync(join(root, name, "state.json"), at, at);
      };
      write("fresh", 1_000);
      write("stale", 10 * 24 * 60 * 60_000);
      mkdirSync(join(root, "no-state"));
      mkdirSync(join(root, ".pending-x"));
      writeFileSync(join(root, "a-file"), "");
      expect(await recentSessionIds(root, Date.now() - 60_000)).toEqual(["fresh"]);
      expect(await recentSessionIds(join(root, "missing"), 0)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
