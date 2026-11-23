import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
export function deviceAcceptanceServer(root, projectId, identity) {
  const { WebSocketServer } = createRequire(root + "/package.json")("ws");
  const wss = new WebSocketServer({ noServer: true }),
    opaque = () => randomBytes(32).toString("base64url");
  const device = {
    hostId: "fixture-target",
    environmentId: "fixture-env",
    name: "fixture device",
    online: true,
    revoked: false,
    protocolVersion: 1,
  };
  const access = opaque(),
    handoff = opaque(),
    relay = opaque(),
    hostAccess = opaque(),
    receipt = opaque();
  let challenge,
    submissions = 0;
  return {
    bind(server) {
      server.on("upgrade", (req, socket, head) => {
        assert.equal(req.url, "/ws");
        assert.equal(req.headers.origin, identity().origin);
        assert.equal(req.headers.authorization, undefined);
        assert.equal(req.headers["x-codeshell-relay-access"], relay);
        assert.equal(req.headers["x-codeshell-host-access"], hostAccess);
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("error", () => {});
          ws.on("message", (bytes) => {
            const e = JSON.parse(String(bytes));
            const reply = (data) => ws.send(JSON.stringify(data));
            if (e.type === "auth.device") return reply({ type: "auth.ok" });
            if (e.type === "session.create")
              return reply({
                type: "chat.accepted",
                sessionId: "fixture-session",
                projectId,
                clientRequestId: e.clientRequestId,
              });
            assert.equal(e.type, "chat.send");
            assert.equal(e.text, "fixture");
            assert.equal(++submissions, 1);
            reply({
              type: "chat.accepted",
              sessionId: "fixture-session",
              clientMessageId: e.clientMessageId,
            });
          });
        });
      });
    },
    response(req, body) {
      const { origin, token } = identity(),
        path = req.url;
      if (
        path.startsWith("/api/v1/remote-hosts") ||
        path.startsWith("/api/v1/account/remote-access/")
      )
        assert.equal(req.headers.authorization, "Bearer " + token);
      if (path === "/api/v1/remote-hosts") return { hosts: [{ ...device, publicOrigin: origin }] };
      if (path === "/api/v1/account/remote-access/start") {
        assert.equal(body.hostId, device.hostId);
        assert.equal(body.sourceHostId, "fixture-source");
        assert.equal(body.sourceDeviceCredential, "fixture-source-proof");
        challenge = body.codeChallenge;
        return {
          receipt,
          authorizationUrl: origin + "/remote-access?request=" + opaque(),
          expiresAt: Date.now() + 60_000,
        };
      }
      if (path === "/api/v1/account/remote-access/poll") {
        assert.equal(body.receipt, receipt);
        assert.equal(createHash("sha256").update(body.codeVerifier).digest("base64url"), challenge);
        return {
          authorization: access,
          hostId: device.hostId,
          environmentId: device.environmentId,
          sourceHostId: "fixture-source",
          expiresAt: Date.now() + 20_000,
        };
      }
      if (path === "/api/v1/remote-hosts/fixture-target/handoffs") {
        assert.equal(body.authorization, access);
        return {
          hostId: device.hostId,
          environmentId: device.environmentId,
          publicOrigin: origin,
          handoff,
          relayAccessToken: relay,
        };
      }
      if (path.startsWith("/api/v1/relay/")) {
        assert.equal(req.headers.authorization, undefined);
        assert.equal(req.headers["x-codeshell-relay-access"], relay);
        if (path.endsWith("/session")) {
          assert.equal(body.handoff, handoff);
          return {
            hostId: device.hostId,
            environmentId: device.environmentId,
            hostAccessToken: hostAccess,
            deviceId: "fixture-device",
            secretHash: "fixture-proof",
            expiresAt: Date.now() + 60_000,
          };
        }
        assert.equal(path, "/api/v1/relay/projects");
        assert.equal(req.headers["x-codeshell-host-access"], hostAccess);
        return {
          hostId: device.hostId,
          environmentId: device.environmentId,
          projects: [{ id: projectId, name: "fixture", path: "/fixture" }],
        };
      }
    },
    finish() {
      assert.equal(submissions, 1);
      wss.close();
    },
  };
}
