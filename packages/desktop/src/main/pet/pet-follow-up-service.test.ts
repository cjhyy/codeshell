import { describe, expect, test } from "bun:test";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import { petFollowUpStateId } from "../../shared/pet-work-item-id.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";
import { createPetFollowUpService } from "./pet-follow-up-service.js";
import { petFollowUpId } from "./pet-follow-up-id.js";
import type { PetSummaryService } from "./pet-summary-service.js";
import type { PetSummaryEntry, PetSummaryStore } from "./pet-summary-store.js";
import type { PetWorkInboxSnapshot } from "./pet-work-inbox-store.js";
import { PetRegisteredFollowUpStore } from "./pet-registered-follow-up-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function session(
  id: string,
  options: { terminalAt?: number; external?: boolean; title?: string } = {},
): DesktopPetSession {
  const terminalAt = options.terminalAt;
  return {
    agentSessionId: id,
    title: options.title ?? `Title ${id}`,
    workspaceDisplayName: "workspace",
    runState: terminalAt === undefined ? "dormant" : "terminal",
    queueDepth: 0,
    lastActivityAt: terminalAt ?? 1,
    pendingDecisionCount: 0,
    ...(terminalAt === undefined ? {} : { terminal: { status: "completed", at: terminalAt } }),
    ...(options.external ? { external: { cli: "codex" as const } } : {}),
    freshness: { source: "disk", observedAt: 1, workerState: "active" },
  };
}

function summaryStore(seed: Record<string, PetSummaryEntry> = {}): PetSummaryStore {
  const entries = new Map(Object.entries(seed));
  return {
    load: async () => undefined,
    get: (id) => entries.get(id),
    set: (id, terminalAt, text) => void entries.set(id, { terminalAt, text }),
    flush: async () => undefined,
  };
}

function inbox(initial: readonly string[] = []): {
  getSnapshot(): PetWorkInboxSnapshot;
  addIfAbsentDurably(id: string): Promise<{ added: boolean; snapshot: PetWorkInboxSnapshot }>;
  flushes: number;
} {
  const ids = new Set<string>(initial);
  let revision = 0;
  return {
    flushes: 0,
    getSnapshot: () => ({ revision, dismissedIds: [...ids] }),
    async addIfAbsentDurably(id) {
      if (ids.has(id)) return { added: false, snapshot: this.getSnapshot() };
      ids.add(id);
      revision += 1;
      this.flushes += 1;
      return { added: true, snapshot: this.getSnapshot() };
    },
  };
}

describe("PetFollowUpService", () => {
  test("gives the workbench and Mimi one canonical Needs-follow-up feed", async () => {
    const workInbox = inbox();
    const summaries = summaryStore({
      "session-a": { terminalAt: 100, text: "decide whether to publish" },
    });
    let generated = 0;
    const summaryService: PetSummaryService = {
      summarize: async () => {
        generated += 1;
        return { text: "must not be generated" };
      },
    };
    const service = createPetFollowUpService({
      listSessions: () => [
        session("session-running"),
        session("session-external", { terminalAt: 120, external: true }),
        session("session-a", { terminalAt: 100, title: "Release" }),
      ],
      summaryStore: summaries,
      summaryService,
      inbox: workInbox,
    });

    const rows = await service.collect();
    const open = await service.listOpen();
    const followUpId = petFollowUpId("session-a", 100);
    expect(rows).toEqual([
      {
        kind: "derived-session",
        followUpId,
        sessionId: "session-a",
        title: "Release",
        workspace: "workspace",
        terminalAt: 100,
        text: "decide whether to publish",
      },
    ]);
    expect(open).toEqual([
      {
        kind: "derived-session",
        id: followUpId,
        title: "Release",
        text: "decide whether to publish",
        workspace: "workspace",
        terminalAt: 100,
        sessionSelector: sessionSelectorId("session-a"),
      },
    ]);
    expect(generated).toBe(0);
  });

  test("uses the same durable handled state for UI and Mimi without hiding source history", async () => {
    const workInbox = inbox();
    const service = createPetFollowUpService({
      listSessions: () => [session("session-a", { terminalAt: 100, title: "Release" })],
      summaryStore: summaryStore({
        "session-a": { terminalAt: 100, text: "decide whether to publish" },
      }),
      summaryService: { summarize: async () => null },
      inbox: workInbox,
    });
    const followUpId = petFollowUpId("session-a", 100);

    await expect(service.mutate({ action: "complete", followUpId })).resolves.toEqual({
      action: "complete",
      followUpId,
      title: "Release",
    });
    expect(workInbox.getSnapshot().dismissedIds).toEqual([petFollowUpStateId(followUpId)]);
    expect(workInbox.getSnapshot().dismissedIds).not.toContain("completed:session-a");
    expect(workInbox.flushes).toBe(1);
    expect(await service.listOpen()).toEqual([]);
    // The renderer still receives the canonical row and applies the exact same
    // state id, so completed-session history remains independently visible.
    expect(await service.collect()).toHaveLength(1);
    await expect(service.mutate({ action: "dismiss", followUpId })).rejects.toThrow("已处理");
  });

  test("a later completion becomes a new follow-up even when the old one was handled", async () => {
    const workInbox = inbox();
    let terminalAt = 100;
    const summaries = summaryStore({
      "session-a": { terminalAt: 100, text: "old decision" },
    });
    const summaryService: PetSummaryService = {
      summarize: async (_id, at) => {
        summaries.set("session-a", at, "new decision");
        return { text: "new decision" };
      },
    };
    const service = createPetFollowUpService({
      listSessions: () => [session("session-a", { terminalAt })],
      summaryStore: summaries,
      summaryService,
      inbox: workInbox,
    });

    const oldId = petFollowUpId("session-a", 100);
    await service.mutate({ action: "complete", followUpId: oldId });
    terminalAt = 200;

    const open = await service.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(petFollowUpId("session-a", 200));
    expect(open[0]!.id).not.toBe(oldId);
    expect(open[0]!.text).toBe("new decision");
  });

  test("handled recent rows do not hide an older open follow-up behind the display limit", async () => {
    const sessions = Array.from({ length: 21 }, (_, index) =>
      session(`session-${index + 1}`, { terminalAt: index + 1 }),
    );
    const seededSummaries = Object.fromEntries(
      sessions.map((item) => [
        item.agentSessionId,
        { terminalAt: item.terminal!.at, text: `follow up ${item.agentSessionId}` },
      ]),
    );
    const handledNewest = sessions
      .slice(1)
      .map((item) => petFollowUpStateId(petFollowUpId(item.agentSessionId, item.terminal!.at)));
    const service = createPetFollowUpService({
      listSessions: () => sessions,
      summaryStore: summaryStore(seededSummaries),
      summaryService: { summarize: async () => null },
      inbox: inbox(handledNewest),
    });

    const open = await service.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(petFollowUpId("session-1", 1));
  });

  test("rejects guessed mutation ids before touching the canonical feed", async () => {
    let listed = 0;
    const service = createPetFollowUpService({
      listSessions: () => {
        listed += 1;
        return [];
      },
      summaryStore: summaryStore(),
      summaryService: { summarize: async () => null },
      inbox: inbox(),
    });

    await expect(service.mutate({ action: "complete", followUpId: "session-a" })).rejects.toThrow(
      "invalid follow-up mutation request",
    );
    expect(listed).toBe(0);
  });

  test("lets only one concurrent UI-or-Mimi mutation report success", async () => {
    const workInbox = inbox();
    const service = createPetFollowUpService({
      listSessions: () => [session("session-a", { terminalAt: 100, title: "Release" })],
      summaryStore: summaryStore({
        "session-a": { terminalAt: 100, text: "decide whether to publish" },
      }),
      summaryService: { summarize: async () => null },
      inbox: workInbox,
    });
    const followUpId = petFollowUpId("session-a", 100);

    const settled = await Promise.allSettled([
      service.mutate({ action: "complete", followUpId }),
      service.mutate({ action: "dismiss", followUpId }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(workInbox.flushes).toBe(1);
  });

  test("unifies independently registered reminders and derived work without inventing a Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pet-followup-feed-"));
    try {
      const registered = new PetRegisteredFollowUpStore(join(root, "registered.json"), {
        now: () => 1_000,
      });
      const service = createPetFollowUpService({
        listSessions: () => [session("session-a", { terminalAt: 100 })],
        summaryStore: summaryStore({ "session-a": { terminalAt: 100, text: "发布前决定" } }),
        summaryService: { summarize: async () => null },
        inbox: inbox(),
        registered,
      });
      const row = await service.register({
        operationKey: "user-turn",
        title: "交材料",
        text: "提醒我交材料",
        wakeAt: 5_000,
        timezone: "Asia/Singapore",
        intent: "remind",
      });
      const open = await service.listOpen();
      expect(open).toHaveLength(2);
      expect(open[0]).toMatchObject({
        kind: "registered",
        id: row.id,
        revision: 1,
        wakeAt: 5_000,
        wakeState: "scheduled",
        status: "open",
      });
      expect(open[0]!.sessionSelector).toBeUndefined();
      expect(open[1]!.kind).toBe("derived-session");
      await expect(service.mutate({ action: "complete", followUpId: row.id })).rejects.toThrow(
        "expectedRevision",
      );
      await service.mutate({ action: "complete", followUpId: row.id, expectedRevision: 1 });
      expect(await service.listOpen()).toHaveLength(1);
      expect((await service.collect()).find((item) => item.followUpId === row.id)).toMatchObject({
        kind: "registered",
        status: "completed",
        revision: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("canonical native controls fence wake callbacks and preserve unknown delivery detail", async () => {
    const root = await mkdtemp(join(tmpdir(), "pet-followup-feed-"));
    try {
      let now = 1_000;
      const registered = new PetRegisteredFollowUpStore(join(root, "registered.json"), {
        now: () => now,
      });
      const service = createPetFollowUpService({
        listSessions: () => [],
        summaryStore: summaryStore(),
        summaryService: { summarize: async () => null },
        inbox: inbox(),
        registered,
      });
      const row = await service.register({
        operationKey: "turn",
        title: "提醒",
        text: "提醒",
        wakeAt: 2_000,
        timezone: "UTC",
        intent: "remind",
      });
      now = 2_000;
      await registered.claimWake(row.id, 1);
      await registered.completeWake(row.id, 1, {
        status: "unknown",
        detail: "可能已发送，未盲目重试",
      });
      expect((await service.listOpen())[0]).toMatchObject({
        wakeState: "unknown",
        wakeDetail: "可能已发送，未盲目重试",
      });
      await service.mutate({
        action: "reschedule",
        followUpId: row.id,
        expectedRevision: 1,
        wakeAt: 3_000,
        timezone: "Asia/Singapore",
      });
      expect(await registered.claimWake(row.id, 1)).toBeUndefined();
      await service.mutate({ action: "cancel", followUpId: row.id, expectedRevision: 2 });
      expect(await service.listOpen()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
