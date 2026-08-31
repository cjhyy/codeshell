import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NotificationQueue,
  type NotificationQueuePersistence,
  type ResultEnvelopeDraft,
} from "./agent-notifications.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codeshell-notification-queue-"));
  tempRoots.push(root);
  return root;
}

function persistence(root: string): NotificationQueuePersistence {
  return {
    fileForSession: (sessionId) => join(root, sessionId, "pending-notifications.json"),
    listSessionIds: () =>
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
  };
}

function result(workId = "worker", sequenceSource = "child"): ResultEnvelopeDraft {
  return {
    kind: "result",
    from: { sessionId: sequenceSource, agentId: workId, authority: "agent" },
    to: { sessionId: "parent", agentId: "brain", authority: "agent" },
    delivery: "idle-drain",
    payload: {
      workId,
      description: "inspect",
      status: "completed",
      workKind: "agent",
      finalText: "done",
      finishedAt: 100,
    },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("NotificationQueue persistence", () => {
  it("restores terminal results after restart with aliases and sequence state", () => {
    const root = tempRoot();
    const first = new NotificationQueue();
    first.attachPersistence(persistence(root));
    const original = first.enqueue(result())!;

    const restarted = new NotificationQueue();
    restarted.attachPersistence(persistence(root));
    const snapshot = restarted.getSnapshot("parent");
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ id: original.id, kind: "result", sequence: 1 });

    const drained = restarted.drainAll("parent");
    expect(drained[0]!.finalText).toBe("done");
    expect(drained[0]!.description).toBe("inspect");

    const next = restarted.enqueue(result())!;
    expect(next.sequence).toBe(2);
  });

  it("quarantines malformed state without throwing or inventing results", () => {
    const root = tempRoot();
    const sessionDir = join(root, "parent");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "pending-notifications.json"), '{"schemaVersion":1,"results":[');

    const queue = new NotificationQueue();
    queue.attachPersistence(persistence(root));
    expect(queue.getSnapshot("parent")).toHaveLength(0);
    expect(readdirSync(sessionDir).some((name) => name.endsWith(".corrupt"))).toBe(true);
  });

  it("persists drain and restore as mailbox commits", () => {
    const root = tempRoot();
    const queue = new NotificationQueue();
    queue.attachPersistence(persistence(root));
    const envelope = queue.enqueue(result())!;
    const file = join(root, "parent", "pending-notifications.json");

    const drained = queue.drainAll("parent");
    expect(drained).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).results).toEqual([]);

    expect(queue.restoreResults("parent", drained)).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).results).toEqual([
      expect.objectContaining({ id: envelope.id }),
    ]);
  });

  it("startup inventory returns only sessions with pending results", () => {
    const root = tempRoot();
    const first = new NotificationQueue();
    first.attachPersistence(persistence(root));
    first.enqueue(result());
    first.enqueue({
      kind: "progress",
      from: { sessionId: "child", agentId: "worker", authority: "agent" },
      to: { sessionId: "progress-only", authority: "system" },
      delivery: "observe-only",
      payload: {
        phase: "model",
        tokens: { prompt: 1, completion: 0, total: 1 },
        summary: "working",
        observedAt: 1,
      },
    });

    const restarted = new NotificationQueue();
    restarted.attachPersistence(persistence(root));
    expect(restarted.restorePersistedSessions()).toEqual(["parent"]);
  });
});
