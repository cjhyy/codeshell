import assert from "node:assert/strict";
import { request } from "node:https";
import WebSocket from "ws";
import { createCloudAccountTransport } from "@cjhyy/code-shell-server/account";
import { NativeAccountDevices } from "../../packages/desktop/src/main/desktop-host/account-devices-client.js";
import type { NativeCloudAccount } from "../../packages/desktop/src/main/desktop-host/cloud-client.js";
import type { PrivateHostPeer } from "../../packages/desktop/src/host/native-peer.js";

/** Only the single HTTPS/WebSocket fixture socket is available; use the generated test CA in both directions. */
export function deviceTransports(origin: string, ca: Buffer) {
  const cloudRequest = createCloudAccountTransport(ca);
  return {
    request: (input: Parameters<typeof cloudRequest>[0]) => {
      assert.equal(input.origin, origin);
      return cloudRequest(input);
    },
    fetch: (async (address: string, init: RequestInit) => {
      const url = new URL(address);
      assert.equal(url.origin, origin);
      return new Promise<Response>((resolve, reject) => {
        const outbound = request(
          url,
          {
            ca,
            method: init.method,
            headers: init.headers as Record<string, string>,
            signal: init.signal ?? undefined,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("error", reject);
            res.on("end", () =>
              resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })),
            );
          },
        );
        outbound.on("error", reject);
        outbound.end(init.body);
      });
    }) as typeof fetch,
    socket: (address: string, headers: Record<string, string>) => {
      assert.equal(new URL(address).origin, origin.replace("https:", "wss:"));
      return new WebSocket(address, { headers, ca, followRedirects: false });
    },
  };
}

export function nativeDevices(
  peer: () => PrivateHostPeer,
  account: NativeCloudAccount,
  origin: string,
) {
  let opens = 0;
  const events: unknown[] = [];
  const devices = new NativeAccountDevices(peer, {
    account,
    openExternal: async (url) => {
      assert.equal(new URL(url).origin, origin);
      assert.equal(new URL(url).pathname, "/remote-access");
      opens++;
    },
    relayOrigin: async (id) => {
      assert.equal(id.origin, origin);
      return origin;
    },
  });
  devices.setEventSink((owner, event) => events.push({ owner, event }));
  return {
    devices,
    async exercise(projectId: string) {
      const records = await devices.list(1);
      assert.equal(records[0].hostId, "fixture-target");
      assert.equal(opens, 0);
      const projects = await devices.projects(1, { hostId: "fixture-target" });
      assert.equal(projects[0].id, projectId);
      const connection = await devices.connect(1, { hostId: "fixture-target", projectId });
      assert.equal(opens, 1);
      await assert.rejects(devices.send(2, { connectionId: connection.id, text: "wrong owner" }));
      await devices.send(1, { connectionId: connection.id, text: "fixture" });
      for (let i = 0; i < 200 && events.length === 0; i++)
        await new Promise((r) => setTimeout(r, 5));
      assert.ok(events.some((e: any) => e.owner === 1 && e.event.event?.type === "chat.accepted"));
      devices.releaseOwner(1);
      await assert.rejects(devices.send(1, { connectionId: connection.id, text: "stale" }));
    },
  };
}
