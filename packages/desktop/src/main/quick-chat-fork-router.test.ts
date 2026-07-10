import { describe, expect, test } from "bun:test";
import type { QuickChatForkRequest } from "./agent-bridge-fallback.js";
import { QuickChatForkRouter, type QuickChatForkResponseTarget } from "./quick-chat-fork-router.js";
import { QuickChatOwnershipRegistry } from "./quick-chat-ownership.js";

function request(ownerId: number, sessionId: string, claimId: string): QuickChatForkRequest {
  return { requestId: 1, ownerId, sessionId, claimId };
}

function responseTarget(id: number): QuickChatForkResponseTarget & {
  destroyed: boolean;
  messages: Array<{ channel: string; payload: string }>;
} {
  return {
    id,
    destroyed: false,
    messages: [],
    isDestroyed() {
      return this.destroyed;
    },
    send(channel, payload) {
      this.messages.push({ channel, payload });
    },
  };
}

describe("QuickChatForkRouter", () => {
  test("isolates two windows whose preload RPC counters both start at id=1", async () => {
    const ownership = new QuickChatOwnershipRegistry();
    const deleted: string[] = [];
    const lifecycle = {
      begin: ({ sessionId, ownerId, claimId }: QuickChatForkRequest) =>
        ownership.beginFork(sessionId, ownerId, claimId),
      settle: async ({
        sessionId,
        ownerId,
        claimId,
        succeeded,
      }: QuickChatForkRequest & { succeeded: boolean }) => {
        await ownership.settleFork(sessionId, ownerId, claimId, succeeded, async () => {
          deleted.push(sessionId);
        });
      },
    };
    const router = new QuickChatForkRouter(lifecycle);
    const firstTarget = responseTarget(101);
    const secondTarget = responseTarget(202);
    const first = request(101, "qchat-window-one", "claim-one");
    const second = request(202, "qchat-window-two", "claim-two");
    ownership.claim(first.sessionId, first.ownerId, first.claimId);
    ownership.claim(second.sessionId, second.ownerId, second.claimId);

    const firstWireLine = router.start(
      first,
      firstTarget,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent/forkSession", params: {} }),
    );
    const secondWireLine = router.start(
      second,
      secondTarget,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent/forkSession", params: {} }),
    );
    const firstWireId = JSON.parse(firstWireLine!.line).id as string;
    const secondWireId = JSON.parse(secondWireLine!.line).id as string;

    expect(firstWireId).not.toBe(secondWireId);
    expect(router.pendingCount).toBe(2);

    // Closing/tombstoning window one must not disturb window two's same-local-id fork.
    expect(
      await ownership.cleanup(first.sessionId, first.ownerId, first.claimId, async () => {
        deleted.push(first.sessionId);
      }),
    ).toEqual({ deleted: false, deferred: true });
    firstTarget.destroyed = true;

    const secondSettlement = router.routeWorkerResponse(
      JSON.stringify({ jsonrpc: "2.0", id: secondWireId, result: { sessionId: second.sessionId } }),
    );
    expect(secondSettlement).not.toBeNull();
    await secondSettlement;
    expect(secondTarget.messages).toHaveLength(1);
    expect(JSON.parse(secondTarget.messages[0]!.payload)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: second.sessionId },
    });
    expect(firstTarget.messages).toEqual([]);
    expect(router.pendingCount).toBe(1);
    expect(ownership.isClaimActive(second.sessionId, second.ownerId, second.claimId)).toBe(true);

    // The late reply is consumed by its global key, settles cleanup, and is not
    // delivered to the destroyed window or mistaken for window two's id=1.
    const firstSettlement = router.routeWorkerResponse(
      JSON.stringify({ jsonrpc: "2.0", id: firstWireId, result: { sessionId: first.sessionId } }),
    );
    expect(firstSettlement).not.toBeNull();
    await firstSettlement;
    expect(firstTarget.messages).toEqual([]);
    expect(secondTarget.messages).toHaveLength(1);
    expect(deleted).toEqual([first.sessionId]);
    expect(router.pendingCount).toBe(0);
  });

  test("a tombstoned fork is cleaned if the worker exits before replying", async () => {
    const ownership = new QuickChatOwnershipRegistry();
    const deleted: string[] = [];
    const lifecycle = {
      begin: ({ sessionId, ownerId, claimId }: QuickChatForkRequest) =>
        ownership.beginFork(sessionId, ownerId, claimId),
      settle: async ({
        sessionId,
        ownerId,
        claimId,
        succeeded,
      }: QuickChatForkRequest & { succeeded: boolean }) => {
        await ownership.settleFork(sessionId, ownerId, claimId, succeeded, async () => {
          deleted.push(sessionId);
        });
      },
    };
    const router = new QuickChatForkRouter(lifecycle);
    const target = responseTarget(303);
    const fork = request(303, "qchat-worker-exit", "claim-exit");
    ownership.claim(fork.sessionId, fork.ownerId, fork.claimId);
    expect(
      router.start(
        fork,
        target,
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent/forkSession", params: {} }),
      ),
    ).not.toBeNull();
    await ownership.cleanup(fork.sessionId, fork.ownerId, fork.claimId, async () => {
      deleted.push(fork.sessionId);
    });
    target.destroyed = true;

    await router.failAll();

    expect(deleted).toEqual([fork.sessionId]);
    expect(router.pendingCount).toBe(0);
    expect(target.messages).toEqual([]);
  });
});
