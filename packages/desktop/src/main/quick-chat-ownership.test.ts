import { describe, expect, test } from "bun:test";
import { QuickChatOwnershipRegistry } from "./quick-chat-ownership";

describe("QuickChatOwnershipRegistry", () => {
  test("a cleanup requester cannot delete a quick chat owned by another window", async () => {
    const registry = new QuickChatOwnershipRegistry();
    const deleted: string[] = [];

    registry.claim("qchat-live", 101);

    const whileOwned = await registry.cleanup("qchat-live", 202, async () => {
      deleted.push("qchat-live");
    });

    expect(whileOwned).toEqual({ deleted: false });
    expect(deleted).toEqual([]);

    registry.release("qchat-live", 101);
    const afterRelease = await registry.cleanup("qchat-live", 202, async () => {
      deleted.push("qchat-live");
    });

    expect(afterRelease).toEqual({ deleted: true });
    expect(deleted).toEqual(["qchat-live"]);
  });

  test("releasing a destroyed window drops all of its quick-chat leases", async () => {
    const registry = new QuickChatOwnershipRegistry();
    const deleted: string[] = [];

    registry.claim("qchat-one", 101);
    registry.claim("qchat-two", 101);
    registry.releaseOwner(101);

    await registry.cleanup("qchat-one", 202, async () => {
      deleted.push("qchat-one");
    });
    await registry.cleanup("qchat-two", 202, async () => {
      deleted.push("qchat-two");
    });

    expect(deleted).toEqual(["qchat-one", "qchat-two"]);
  });
});
