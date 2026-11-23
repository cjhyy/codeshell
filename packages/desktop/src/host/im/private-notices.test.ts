import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayControlServer } from "../../main/im-gateway-control-server.js";
import { PrivateImNotices } from "./private-notices.js";

test("an enqueued private notice survives restart and is withheld immediately after a direct chat loses authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-private-notice-"));
  const descriptorPath = join(root, "desktop-control.json");
  let direct = true;
  const target = { channel: "dingtalk", target: "synthetic-room" };
  const owner = { targetId: "synthetic-opaque-target", nonDirectBody: "Open Desktop to review." };
  const key = "8".repeat(64);
  const create = () => {
    const copies = new PrivateImNotices(
      join(root, "private-notices.json"),
      (id, address) => direct && id === owner.targetId && address.target === target.target,
      (key) => server.deliveryState(key) === "pending",
    );
    const server: GatewayControlServer = new GatewayControlServer({
      descriptorPath,
      projectEvent: (copy) => copies.project(copy),
      status: () => {
        throw Error("unused");
      },
      close: async () => {},
      open: async () => {
        throw Error("unused");
      },
      pairingUrl: () => {
        throw Error("unused");
      },
    });
    return { server, copies };
  };
  let host = create();
  const poll = async () => {
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    const response = await fetch(descriptor.baseUrl + "/v1/events?after=0&waitMs=0", {
      headers: { Authorization: "Bearer " + descriptor.token },
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ streamId: string; events: { id: number; text: string }[] }>;
  };
  try {
    await host.server.start();
    const stored = await host.server.publish(
      {
        deliveryKey: key,
        target,
        type: "pet.task.reported",
        text: "synthetic private contents",
        maxAttempts: 5,
      },
      {
        check() {
          if (!direct) throw Error("recipient changed");
        },
        prepare: (event) => host.copies.prepare(event, owner),
      },
    );
    expect(stored.text).toBe(owner.nonDirectBody);
    expect(await readFile(descriptorPath + ".events", "utf8")).not.toContain(
      "synthetic private contents",
    );
    expect((await poll()).events[0]?.text).toBe("synthetic private contents");
    await host.server.stop();
    host = create();
    await host.server.start();
    const page = await poll();
    expect(page.events[0]?.text).toBe("synthetic private contents");
    expect(host.server.isEventLive(page.streamId, stored.id)).toBe(true);
    direct = false;
    expect(host.server.isEventLive(page.streamId, stored.id)).toBe(false);
    expect((await poll()).events).toEqual([]);
    expect(host.server.eventForDelivery(stored)).toBeUndefined();
    expect(host.server.deliveryState(key)).toBe("pending");
  } finally {
    await host.server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
