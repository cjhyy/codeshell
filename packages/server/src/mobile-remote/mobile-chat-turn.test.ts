import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { installFixtureNetworkGuard } from "../../../../tests/helpers/network-fixture.js";
const guard = installFixtureNetworkGuard();
const { markAttachmentsSent, cleanupAttachments, DRAFT_ATTACHMENT_TTL_MS } =
  await import("../attachment-service.js");
const { dispatchMobileChatTurn } = await import("./mobile-chat-turn.js");
const { injectMobileRunAndAwaitAcceptance } = await import("./mobile-run-dispatch.js");
const { MobileUploadService } = await import("./mobile-upload-service.js");
type MobileUploadService = InstanceType<typeof MobileUploadService>;
afterAll(() => guard.restore());

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
  const origin = `http://127.0.0.1:${address.port}`;
  guard.allowOrigin(origin);
  const response = await fetch(`${origin}${ticket.putUrl}`, {
    redirect: "error",
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
      clientMessageId: "phone-message-1",
      modelTraceSource: "panel:design-studio",
      projectId: "project-1",
      rootId: "root-2",
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
      meta: { origin: "mobile", producer: "mobile-chat" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.cwd).toBe(worktree);
    expect(injected.params).toMatchObject({
      task: "",
      cwd: worktree,
      sessionId: "safe-session",
      clientMessageId: "phone-message-1",
      modelTraceSource: "panel:design-studio",
      attachments: [{ origin: "mobile", sessionId: "safe-session", mime: "image/png" }],
      projectId: "project-1",
      rootId: "root-2",
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
      meta: { origin: "mobile", producer: "mobile-chat" },
    });

    expect(result).toEqual({ ok: false, message: "rejected" });
    const retried = service.claim("device-1", ticket.uploadId);
    await service.finalize("device-1", ticket.uploadId, retried.claimId);
  });

  test("uncertain admission preserves staged attachments and releases only retryable spool claims", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-mobile-uncertain-"));
    roots.push(root);
    mkdirSync(join(root, "workspace"));
    const cwd = realpathSync(join(root, "workspace"));
    const uploads = new MobileUploadService({ rootDir: join(root, "spool"), cleanupIntervalMs: 0 });
    services.push(uploads);
    const ticket = await uploadedFixture(uploads);
    const injected: any[] = [];
    let outbound: ((line: string) => void) | undefined;
    let acknowledge = false;
    let marked = 0;
    const bridge = {
      subscribeOutbound(listener: (line: string) => void) {
        outbound = listener;
        return () => {
          outbound = undefined;
        };
      },
      injectWorkerMessage(line: string) {
        const request = JSON.parse(line);
        injected.push(request);
        if (acknowledge)
          queueMicrotask(() =>
            outbound?.(
              JSON.stringify({ method: "agent/runAccepted", params: { requestId: request.id } }),
            ),
          );
      },
    };
    const meta = { origin: "mobile" as const, producer: "mobile-chat" };
    const input = {
      deviceId: "device-1",
      sessionId: "slow-session",
      fallbackCwd: cwd,
      text: "only once",
      clientMessageId: "stable-intent",
      runId: "initial-run",
      attachments: [
        {
          transport: "upload" as const,
          uploadId: ticket.uploadId,
          clientId: "image-1",
          name: "phone.png",
          mime: "image/png" as const,
          size: PNG.length,
        },
      ],
      uploads,
      bridge,
      meta,
      resolveWorkspace: async () => cwd,
      markSent: async (...args: Parameters<typeof markAttachmentsSent>) => {
        marked++;
        await markAttachmentsSent(...args);
      },
      submit: (request: Parameters<typeof injectMobileRunAndAwaitAcceptance>[1]) =>
        injectMobileRunAndAwaitAcceptance(bridge, request, meta, 10),
    };
    expect(await dispatchMobileChatTurn(input)).toEqual({
      ok: false,
      uncertain: true,
      clientMessageId: "stable-intent",
      message: "worker did not acknowledge the run",
    });
    expect(marked).toBe(1);
    const canonical = injected[0].params.attachments[0];
    expect(readFileSync(canonical.absPath)).toEqual(PNG);
    await cleanupAttachments({
      cwd,
      now: Date.now() + DRAFT_ATTACHMENT_TTL_MS + 1000,
    });
    expect(readFileSync(canonical.absPath)).toEqual(PNG);
    // The first worker still owns canonical bytes. Retrying need not reupload
    // and cannot finalize/delete the upload before acceptance is known.
    const claim = uploads.claim("device-1", ticket.uploadId);
    await uploads.release("device-1", ticket.uploadId, claim.claimId);
    acknowledge = true;
    const retried = await dispatchMobileChatTurn({ ...input, runId: "retry-run" });
    expect(retried.ok).toBe(true);
    expect(injected.map((request) => request.params.clientMessageId)).toEqual([
      "stable-intent",
      "stable-intent",
    ]);
    expect(injected[1].params.attachments[0].sha256).toBe(canonical.sha256);
    expect(readFileSync(canonical.absPath)).toEqual(PNG);
    expect(marked).toBe(2);
    expect(() => uploads.claim("device-1", ticket.uploadId)).toThrow();
  });

  for (const accepted of [false, true]) {
    test(`alternative producer ${accepted ? "committed input survives mark-sent failure" : "ambiguous pre-ack timeout releases claims"} without a native request`, async () => {
      const root = mkdtempSync(join(tmpdir(), "cs-mobile-alternative-"));
      roots.push(root);
      mkdirSync(join(root, "workspace"));
      const cwd = realpathSync(join(root, "workspace"));
      const uploads = new MobileUploadService({
        rootDir: join(root, "spool"),
        cleanupIntervalMs: 0,
      });
      services.push(uploads);
      const ticket = await uploadedFixture(uploads);
      let submissions = 0,
        native = 0;
      const result = await dispatchMobileChatTurn({
        deviceId: "device-1",
        sessionId: "external",
        fallbackCwd: cwd,
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
        clientMessageId: "stable-mobile-id",
        runId: "request",
        uploads,
        resolveWorkspace: async () => cwd,
        bridge: {
          injectWorkerMessage() {
            native++;
          },
          subscribeOutbound() {
            native++;
            return () => {};
          },
        },
        meta: { origin: "mobile", producer: "mobile-chat" },
        submit: async (request) => {
          submissions++;
          expect(request.params.clientMessageId).toBe("stable-mobile-id");
          expect(request.params.attachments).toHaveLength(1);
          if (!accepted) throw new Error("queue deadline before acceptance");
          return { ok: true };
        },
        markSent: async () => {
          throw new Error("disk failed after canonical acceptance");
        },
      });
      expect(result.ok).toBe(accepted);
      if (!accepted)
        expect(result).toMatchObject({ uncertain: true, clientMessageId: "stable-mobile-id" });
      expect(submissions).toBe(1);
      expect(native).toBe(0);
      if (accepted) expect(() => uploads.claim("device-1", ticket.uploadId)).toThrow();
      else {
        const retry = uploads.claim("device-1", ticket.uploadId);
        await uploads.finalize("device-1", ticket.uploadId, retry.claimId);
      }
    });
  }
});
