import { describe, expect, test } from "bun:test";
import { QuickChatOwnershipRegistry } from "./quick-chat-ownership";

describe("QuickChatOwnershipRegistry", () => {
  test("a cleanup requester cannot delete a quick chat owned by another window", async () => {
    const registry = new QuickChatOwnershipRegistry();
    const deleted: string[] = [];

    registry.claim("qchat-live", 101, "claim-live");

    const whileOwned = await registry.cleanup("qchat-live", 202, "other-claim", async () => {
      deleted.push("qchat-live");
    });

    expect(whileOwned).toEqual({ deleted: false });
    expect(deleted).toEqual([]);

    await registry.cleanup("qchat-live", 101, "claim-live", async () => {
      deleted.push("qchat-live");
    });

    expect(deleted).toEqual(["qchat-live"]);
  });

  test("releasing a destroyed window deletes all materialized quick-chat sessions", async () => {
    const registry = new QuickChatOwnershipRegistry();
    const deleted: string[] = [];

    registry.claim("qchat-one", 101, "claim-one");
    registry.claim("qchat-two", 101, "claim-two");
    await registry.releaseOwner(101, async (sessionId) => {
      deleted.push(sessionId);
    });

    expect(deleted.sort()).toEqual(["qchat-one", "qchat-two"]);
  });

  test("tab cleanup tombstones a deferred fork and settled success deletes exactly once", async () => {
    const registry = new QuickChatOwnershipRegistry();
    const deleted: string[] = [];
    const remove = async (sessionId: string) => {
      deleted.push(sessionId);
    };

    registry.claim("qchat-deferred", 101, "generation-1");
    expect(registry.beginFork("qchat-deferred", 101, "generation-1")).toBe(true);
    expect(
      await registry.cleanup("qchat-deferred", 101, "generation-1", () => remove("qchat-deferred")),
    ).toEqual({ deleted: false, deferred: true });
    expect(registry.isClaimActive("qchat-deferred", 101, "generation-1")).toBe(false);
    expect(deleted).toEqual([]);

    expect(
      await registry.settleFork("qchat-deferred", 101, "generation-1", true, () =>
        remove("qchat-deferred"),
      ),
    ).toEqual({ active: false, deleted: true });
    await registry.cleanup("qchat-deferred", 101, "generation-1", () => remove("qchat-deferred"));
    expect(deleted).toEqual(["qchat-deferred"]);
  });

  test("owner destruction tombstones a deferred fork and late settle deletes exactly once", async () => {
    const registry = new QuickChatOwnershipRegistry();
    const deleted: string[] = [];
    const remove = async (sessionId: string) => {
      deleted.push(sessionId);
    };

    registry.claim("qchat-window", 101, "generation-window");
    expect(registry.beginFork("qchat-window", 101, "generation-window")).toBe(true);
    await registry.releaseOwner(101, remove);
    expect(deleted).toEqual([]);

    await registry.settleFork("qchat-window", 101, "generation-window", true, () =>
      remove("qchat-window"),
    );
    await registry.settleFork("qchat-window", 101, "generation-window", true, () =>
      remove("qchat-window"),
    );
    expect(deleted).toEqual(["qchat-window"]);
  });
});
