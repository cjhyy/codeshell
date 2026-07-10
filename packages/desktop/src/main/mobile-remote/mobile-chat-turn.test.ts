import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { markAttachmentsSent } from "../attachment-service.js";
import { dispatchMobileChatTurn } from "./mobile-chat-turn.js";
import { MobileUploadService } from "./mobile-upload-service.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const roots: string[] = [];
const services: MobileUploadService[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function uploadedFixture(service: MobileUploadService) {
  const ticket = service.begin("device-1", {
    clientId: "image-1",
    name: "phone.png",
    mime: "image/png",
    size: PNG.length,
  });
  const server = createServer(
    (request, response) => void service.acceptPut(ticket.uploadId, request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing upload server address");
  const response = await fetch(`http://127.0.0.1:${address.port}${ticket.putUrl}`, {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: PNG,
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(response.status).toBe(201);
  return ticket;
}

describe("dispatchMobileChatTurn", () => {
  test("uses the resolved worktree, canonical meta, and finalizes only after worker acceptance", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-mobile-chat-turn-"));
    roots.push(root);
    const mainWorkspace = join(root, "repo");
    let worktree = join(mainWorkspace, ".worktrees", "feature");
    mkdirSync(worktree, { recursive: true });
    worktree = realpathSync(worktree);
    const service = new MobileUploadService({
      rootDir: join(root, "spool"),
      cleanupIntervalMs: 0,
    });
    services.push(service);
    const ticket = await uploadedFixture(service);
    const order: string[] = [];
    let injected: any;
    let outbound: ((line: string) => void) | undefined;
    const result = await dispatchMobileChatTurn({
      deviceId: "device-1",
      sessionId: "safe-session",
      fallbackCwd: mainWorkspace,
      text: "",
      attachments: [
        {
          transport: "upload",
          uploadId: ticket.uploadId,
          clientId: "image-1",
          name: "phone.png",
          mime: "image/png",
          size: PNG.length,
        },
      ],
      runId: "mobile-run-test",
      resolveWorkspace: async (sessionId, fallback) => {
        order.push("resolve-worktree");
        expect(sessionId).toBe("safe-session");
        expect(fallback).toBe(mainWorkspace);
        return worktree;
      },
      uploads: {
        claim(deviceId, uploadId) {
          order.push("claim");
          return service.claim(deviceId, uploadId);
        },
        release: (deviceId, uploadId, claimId) => service.release(deviceId, uploadId, claimId),
        async finalize(deviceId, uploadId, claimId) {
          order.push("finalize");
          await service.finalize(deviceId, uploadId, claimId);
        },
      },
      markSent: async (cwd, sessionId, metas) => {
        order.push("mark-sent");
        await markAttachmentsSent(cwd, sessionId, metas);
      },
      bridge: {
        subscribeOutbound(listener) {
          outbound = listener;
          return () => {
            outbound = undefined;
          };
        },
        injectWorkerMessage(line) {
          order.push("agent-run");
          injected = JSON.parse(line);
          queueMicrotask(() =>
            outbound?.(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "agent/runAccepted",
                params: { requestId: injected.id, sessionId: "safe-session" },
              }),
            ),
          );
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.cwd).toBe(worktree);
    expect(injected.params).toMatchObject({
      task: "",
      cwd: worktree,
      sessionId: "safe-session",
      attachments: [{ origin: "mobile", sessionId: "safe-session", mime: "image/png" }],
    });
    const meta = injected.params.attachments[0];
    expect(relative(worktree, meta.absPath)).toStartWith(".code-shell/attachments/safe-session/");
    expect(order).toEqual(["resolve-worktree", "claim", "agent-run", "mark-sent", "finalize"]);
    expect(() => service.claim("device-1", ticket.uploadId)).toThrow(/upload/i);
  });

  test("releases the claim when the worker rejects the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-mobile-chat-reject-"));
    roots.push(root);
    let workspace = join(root, "repo");
    mkdirSync(workspace, { recursive: true });
    workspace = realpathSync(workspace);
    const service = new MobileUploadService({
      rootDir: join(root, "spool"),
      cleanupIntervalMs: 0,
    });
    services.push(service);
    const ticket = await uploadedFixture(service);
    let outbound: ((line: string) => void) | undefined;

    const result = await dispatchMobileChatTurn({
      deviceId: "device-1",
      sessionId: "safe-session",
      fallbackCwd: workspace,
      text: "",
      attachments: [
        {
          transport: "upload",
          uploadId: ticket.uploadId,
          clientId: "image-1",
          name: "phone.png",
          mime: "image/png",
          size: PNG.length,
        },
      ],
      runId: "mobile-run-rejected",
      resolveWorkspace: async () => workspace,
      uploads: service,
      bridge: {
        subscribeOutbound(listener) {
          outbound = listener;
          return () => {
            outbound = undefined;
          };
        },
        injectWorkerMessage(line) {
          const request = JSON.parse(line);
          queueMicrotask(() =>
            outbound?.(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32602, message: "rejected" },
              }),
            ),
          );
        },
      },
    });

    expect(result).toEqual({ ok: false, message: "rejected" });
    const retried = service.claim("device-1", ticket.uploadId);
    await service.finalize("device-1", ticket.uploadId, retried.claimId);
  });
});
