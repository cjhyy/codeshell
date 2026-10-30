import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  SessionManager,
  type MobileClientEvent,
  type MobileServerEvent,
  type StreamEvent,
} from "@cjhyy/code-shell-core";
import { SessionOutputJournal, SessionOutputCoverageStore } from "@cjhyy/code-shell-core/internal";
import { SessionSnapshotStore } from "../SessionSnapshotStore.js";
import { MobileOutputRecovery } from "./output-recovery.js";
import { MobileOutputClient } from "../../../../web/src/hooks/mobileOutputClient.js";

// Real Host -> serialized bounded pages -> real browser client, with one
// outstanding read and a deterministic transport delay. No real socket/provider.
test("dense token pages reduce delayed round trips without publishing a partial candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "mobile-history-roundtrips-"));
  const clients: MobileOutputClient[] = [];
  try {
    const manager = new SessionManager(root);
    const session = manager.create(root, "fixture", "fixture", "history");
    manager.startSessionRun(session.state, "run");
    const writer = new SessionOutputJournal(
      root,
      "history",
      "run",
      session.transcript.getEvents().at(-1)!.id,
    );
    let batch: StreamEvent[] = [];
    let outputCursor = "";
    const append = (event: StreamEvent) => {
      if (Buffer.byteLength(JSON.stringify(event)) > 64 * 1024) {
        if (batch.length) outputCursor = writer.appendBatch(batch).at(-1)!;
        batch = [];
        outputCursor = writer.append(event);
        return;
      }
      batch.push(event);
      if (batch.length === 64) {
        outputCursor = writer.appendBatch(batch).at(-1)!;
        batch = [];
      }
    };
    for (let turn = 0; turn < 32; turn++) {
      append({ type: "stream_request_start", turnNumber: turn + 1 });
      for (let index = 0; index < 256; index++)
        append({ type: "text_delta", text: "owned token " });
      const id = `read-${turn}`;
      append({ type: "tool_use_start", toolCall: { id, toolName: "Read", args: {} } });
      // Include true multiframe payloads alongside tiny token records.
      append({
        type: "tool_result",
        result: { id, result: "汉".repeat(turn === 0 ? 100_000 : 8_000) },
      });
      append({ type: "turn_complete", reason: "completed" });
    }
    if (batch.length) outputCursor = writer.appendBatch(batch).at(-1)!;
    const snapshots = new SessionSnapshotStore({
      coverage: new SessionOutputCoverageStore(() => root),
    });
    snapshots.append("history", { type: "turn_complete", reason: "completed", outputCursor });
    const measure = async (dense: boolean) => {
      let pages = 0,
        inFlight = 0,
        maximumInFlight = 0,
        commits = 0,
        maximumFrames = 0;
      let progressCount = 0,
        progressAfterCommit = 0;
      const started = performance.now();
      let resolve!: (result: any) => void, reject!: (error: Error) => void;
      const completed = new Promise<any>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const service = new MobileOutputRecovery({
        root: () => root,
        authority: async () => "mounted-root",
        snapshot: (id) => snapshots.get(id),
        reply: (_viewer, reply) => {
          if (reply.type === "session.outputJournal") {
            pages++;
            maximumFrames = Math.max(maximumFrames, reply.page.frames.length);
            expect(reply.page.frames.length).toBeLessThanOrEqual(dense ? 2048 : 512);
            expect(Buffer.byteLength(JSON.stringify(reply.page))).toBeLessThanOrEqual(
              1024 * 1024 + 16 * 1024,
            );
            setTimeout(() => {
              inFlight--;
              client.observe(JSON.parse(JSON.stringify(reply)));
            }, 30);
          } else queueMicrotask(() => client.observe(reply));
        },
      });
      const client = new MobileOutputClient({
        current: () => ({ sessionId: "history", revision: 1 }),
        send: (request: MobileClientEvent) => {
          if (request.type === "session.outputJournal") {
            inFlight++;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
          }
          const wire = JSON.parse(JSON.stringify(request));
          if (!dense) expect(Object.hasOwn(wire, "maxFrames")).toBe(false);
          void service.handle({ ...wire, viewerId: "viewer", deviceId: "device" }).catch(reject);
          return true;
        },
        progress: (_id, progress) => {
          if (!progress) return;
          progressCount++;
          progressAfterCommit += commits;
          expect(progress.receivedBytes).toBeLessThanOrEqual(progress.totalBytes!);
        },
        commit: (_id, result) => {
          commits++;
          resolve(result);
        },
        failed: () => reject(new Error("verified recovery failed")),
        legacy: () => reject(new Error("journal cannot fall back")),
      });
      clients.push(client);
      client.observe({
        type: "auth.ok",
        capabilities: { outputJournal: 1, ...(dense ? { outputJournalPageFrames: 2048 } : {}) },
        device: { id: "device", name: "fixture" },
      } as MobileServerEvent);
      expect(client.begin("history")).toBe(true);
      const result = await completed;
      expect(commits).toBe(1);
      expect(progressAfterCommit).toBe(0);
      expect(progressCount).toBe(pages);
      expect(maximumInFlight).toBe(1);
      expect(result.outputCursor).toBe(outputCursor);
      expect(result.snapshot.unpaired).toBe(false);
      expect(result.chat.run).toBe("completed");
      const digest = createHash("sha256").update(JSON.stringify(result.chat)).digest("hex");
      client.cancel(false);
      return {
        pages,
        maximumFrames,
        ms: performance.now() - started,
        simulatedNetworkMs: pages * 30,
        digest,
      };
    };
    const standard = await measure(false);
    const dense = await measure(true);
    expect(dense.maximumFrames).toBeGreaterThan(512);
    expect(dense.pages).toBeLessThan(standard.pages * 0.6);
    expect(dense.digest).toBe(standard.digest);
    console.log(JSON.stringify({ standard, dense }));
  } finally {
    for (const client of clients) client.cancel(false);
    rmSync(root, { recursive: true, force: true });
  }
});
