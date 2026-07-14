import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunManager } from "./RunManager.js";
import { FileRunStore } from "./FileRunStore.js";
import type { RunExecutor, RunExecutionHandle } from "./EngineRunner.js";
import type { RunSnapshot } from "./types.js";

// TODO §3.3 — RunManager approval/input resume race.
//
// resume() and cancel() each have several await points, and the status check at
// the top of resume() reads a value that stays `waiting_approval` until a later
// `await transition()` lands. Two concurrent resumes (double-click approve), or
// a resume with mismatched input, used to both pass that check and both drive
// transitions / the re-queue path. These tests pin the serialization guard and
// the mismatched-input rejection.

const dirs: string[] = [];
const managers: RunManager[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rm-race-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Build a RunManager whose executor drives the run into waiting_approval and
 * then suspends on the handle until resolveApproval is called — mimicking a
 * live Engine blocked on a tool approval. Returns a promise that resolves once
 * the run has actually reached waiting_approval (so the test can race resume()).
 */
class BlockingUpdateStore extends FileRunStore {
  private blocked = false;
  private releaseBlock: (() => void) | null = null;
  private blockReleased: Promise<void> | null = null;
  private markBlocked: (() => void) | null = null;
  blockedOnce: Promise<void> | null = null;

  blockNextCancelledUpdate(): void {
    this.blocked = true;
    this.blockedOnce = new Promise<void>((resolve) => {
      this.markBlocked = resolve;
    });
    this.blockReleased = new Promise<void>((resolve) => {
      this.releaseBlock = resolve;
    });
  }

  releaseCancelledUpdate(): void {
    this.releaseBlock?.();
  }

  override async update(snapshot: RunSnapshot): Promise<void> {
    if (this.blocked && snapshot.status === "cancelled") {
      this.blocked = false;
      this.markBlocked?.();
      await this.blockReleased;
    }
    await super.update(snapshot);
  }
}

function makeSuspendingManager(
  storeFactory: (dir: string) => FileRunStore = (dir) => new FileRunStore(dir),
) {
  const dir = tmp();
  const store = storeFactory(dir);
  let reachedWaiting!: () => void;
  const waitingReached = new Promise<void>((r) => {
    reachedWaiting = r;
  });
  let approveCount = 0;

  const executor: RunExecutor = {
    async execute(_run, _context, lifecycleHooks, onHandleReady) {
      // A handle whose resolveApproval unblocks the suspended "engine".
      let resolveSuspend!: (approved: boolean) => void;
      const suspended = new Promise<boolean>((r) => {
        resolveSuspend = r;
      });
      const handle: RunExecutionHandle = {
        resolveApproval: (approved) => {
          approveCount++;
          resolveSuspend(approved);
          return true;
        },
        resolveInput: () => false,
        hasPendingApproval: () => true,
        hasPendingInput: () => false,
      };
      onHandleReady?.(handle);

      // Drive the run to waiting_approval through the real RunManager hook.
      await lifecycleHooks?.onApprovalNeeded({
        toolName: "Bash",
        description: "rm -rf something",
        args: {},
        riskLevel: "high",
      } as Parameters<NonNullable<typeof lifecycleHooks>["onApprovalNeeded"]>[0]);

      reachedWaiting();
      const approved = await suspended;
      return {
        result: {
          text: approved ? "did it" : "skipped",
          reason: "completed",
          sessionId: "s",
          turnCount: 1,
        },
        handle,
      };
    },
  };
  const mgr = new RunManager({ store, executor, runsDir: dir });
  managers.push(mgr);
  return { mgr, store, waitingReached, getApproveCount: () => approveCount };
}

function makeInputSuspendingManager() {
  const dir = tmp();
  const store = new FileRunStore(dir);
  let reachedWaiting!: () => void;
  const waitingReached = new Promise<void>((r) => {
    reachedWaiting = r;
  });
  const answers: string[] = [];

  const executor: RunExecutor = {
    async execute(_run, _context, lifecycleHooks, onHandleReady) {
      let resolveSuspend!: (answer: string) => void;
      const suspended = new Promise<string>((r) => {
        resolveSuspend = r;
      });
      const handle: RunExecutionHandle = {
        resolveApproval: () => false,
        resolveInput: (answer) => {
          answers.push(answer);
          resolveSuspend(answer);
          return true;
        },
        hasPendingApproval: () => false,
        hasPendingInput: () => true,
      };
      onHandleReady?.(handle);

      await lifecycleHooks?.onInputNeeded("say something");
      reachedWaiting();
      const answer = await suspended;
      return {
        result: { text: answer, reason: "completed", sessionId: "s", turnCount: 1 },
        handle,
      };
    },
  };
  const mgr = new RunManager({ store, executor, runsDir: dir });
  managers.push(mgr);
  return { mgr, waitingReached, answers };
}

describe("RunManager resume race (approval)", () => {
  test("two concurrent resumes: exactly one succeeds, the other rejects", async () => {
    const { mgr, store, waitingReached, getApproveCount } = makeSuspendingManager();
    const { runId } = await mgr.submit({ objective: "x", cwd: "/tmp/proj" });
    await waitingReached;

    const pending = await store.getPendingApproval(runId);
    const approvalId = pending?.approvalId ?? "missing";

    const input = { approvalDecision: { approvalId, approved: true, reason: "ok" } };
    const [a, b] = await Promise.allSettled([mgr.resume(runId, input), mgr.resume(runId, input)]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain("already in progress");
    // The handle's resolveApproval ran exactly once.
    expect(getApproveCount()).toBe(1);
  });

  test("waiting_approval resumed with userInput (mismatch) is rejected, not re-queued", async () => {
    const { mgr, waitingReached } = makeSuspendingManager();
    const { runId } = await mgr.submit({ objective: "x", cwd: "/tmp/proj" });
    await waitingReached;

    await expect(mgr.resume(runId, { userInput: "wrong kind" })).rejects.toThrow(/does not match/);
    // Still suspended in waiting_approval — not bounced to queued/running.
    const snap = await mgr.get(runId);
    expect(snap?.status).toBe("waiting_approval");
  });

  test("waiting_approval rejects a stale approval id without resolving the live handle", async () => {
    const { mgr, waitingReached, getApproveCount } = makeSuspendingManager();
    const { runId } = await mgr.submit({ objective: "x", cwd: "/tmp/proj" });
    await waitingReached;

    await expect(
      mgr.resume(runId, {
        approvalDecision: { approvalId: "not-the-pending-id", approved: true, reason: "wrong" },
      }),
    ).rejects.toThrow(/not the latest pending approval/);

    expect(getApproveCount()).toBe(0);
    const snap = await mgr.get(runId);
    expect(snap?.status).toBe("waiting_approval");
  });

  test("cancel racing another cancel is serialized by resolvingRuns", async () => {
    let blockingStore!: BlockingUpdateStore;
    const { mgr, waitingReached } = makeSuspendingManager((dir) => {
      blockingStore = new BlockingUpdateStore(dir);
      return blockingStore;
    });
    const { runId } = await mgr.submit({ objective: "x", cwd: "/tmp/proj" });
    await waitingReached;

    blockingStore.blockNextCancelledUpdate();
    const first = mgr.cancel(runId, "first");
    await blockingStore.blockedOnce;

    await expect(mgr.cancel(runId, "second")).rejects.toThrow(/already in progress/);

    blockingStore.releaseCancelledUpdate();
    await first;
  });

  test("waiting_input accepts an intentional empty string", async () => {
    const { mgr, waitingReached, answers } = makeInputSuspendingManager();
    const { runId } = await mgr.submit({ objective: "x", cwd: "/tmp/proj" });
    await waitingReached;

    await mgr.resume(runId, { userInput: "" });

    expect(answers).toEqual([""]);
  });
});
