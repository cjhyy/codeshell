import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanelAgentTaskOwner } from "./panel-app-agent-task-service.js";
import { installFixtureNetworkGuard } from "../../../../tests/helpers/network-fixture.js";

// No real origins are allowed. Install before Core/SDK evaluation; each model
// call below injects its own exact-origin fake transport instead of networking.
const network = installFixtureNetworkGuard();
afterAll(() => network.restore());
const { PlaintextCipher, UsageLedger, withUsageOwner, OpenAIClient, Transcript } =
  await import("@cjhyy/code-shell-core");
// Use the same built Core module graph as the public SDK and Desktop signer;
// this internal fixture seam does not add a production export for ModelFacade.
const { ModelFacade } = await import("../../../core/dist/engine/model-facade.js");
const { createDesktopModelRequestSigner } = await import("./model-request-signing-service.js");
const { PanelAppAgentTaskService } = await import("./panel-app-agent-task-service.js");
const { PanelAgentTaskOwnership } = await import("./panel-app-agent-task-ownership.js");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { revokeDuringSigning?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "panel-task-signing-"));
  roots.push(root);
  const sessions = join(root, "sessions");
  const owner: PanelAgentTaskOwner = {
    guestId: 7,
    ownerWebContentsId: 9,
    appId: "synthetic-panel",
    appTitle: "Synthetic Panel",
    projectPath: root,
    cwd: root,
    bucket: "synthetic-bucket",
    availableSkills: [],
  };
  let bound = true;
  let generation = 1;
  let reservation:
    | { cwd: string; mainRoot: string; producer: string; reservedAt: number }
    | undefined;
  let windowOwner: number | undefined = owner.ownerWebContentsId;
  let live = true;
  const bridge = {
    workerGeneration: () => generation,
    hasLiveWorker: () => live,
    hostReservation: () => reservation,
    panelOwnerWebContentsId: () => windowOwner,
  };
  let currentBridge: typeof bridge | null = bridge;
  const ownership = new PanelAgentTaskOwnership({
    activeOwner: (id) => service.activeOwner(id),
    currentBridge: () => currentBridge,
    isPanelAppBound: (project, app) => bound && project === root && app === owner.appId,
    isWorkspaceTrusted: (cwd) => cwd === root,
  });
  let checks = 0;
  const signerOptions = {
    hostDirectory: join(root, "host"),
    sessionStorageDir: sessions,
    cipher: new PlaintextCipher(),
    encryptionAvailable: () => false,
    hasActiveEphemeralOwner: () => false,
    hasActiveHostTaskOwner: (id: string) => {
      const active = ownership.hasActiveOwner(id);
      if (options.revokeDuringSigning && checks++ === 0)
        queueMicrotask(() => {
          bound = false;
        });
      return active;
    },
  };
  const signer = createDesktopModelRequestSigner(signerOptions);
  const ledger = new UsageLedger();
  let sends = 0;
  let sessionId = "";
  let release!: () => void;
  let done!: () => void;
  const completed = new Promise<void>((resolve) => {
    done = resolve;
  });
  const client = new OpenAIClient(
    {
      provider: "openai",
      providerKind: "openrouter",
      model: "openai/gpt-6.1-sol",
      apiKey: "synthetic-fixture-key",
      baseUrl: "https://panel-signing.fixture.invalid/v1",
    },
    {
      retryMaxAttempts: 1,
      timeout: 1000,
      fetch: (async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        expect(new URL(url).origin).toBe("https://panel-signing.fixture.invalid");
        sends++;
        return new Response(
          [
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "ready" }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }) as typeof fetch,
    },
  );
  const service = new PanelAppAgentTaskService(
    {
      run: async (input) => {
        sessionId = input.sessionId;
        reservation = {
          cwd: input.owner.cwd,
          mainRoot: input.owner.projectPath,
          producer: "panel-agent-task",
          reservedAt: Date.now(),
        };
        release = ownership.track(sessionId, bridge);
        try {
          const usageOwner = ledger.owner(sessionId);
          const transcript = Transcript.inMemory(sessionId);
          const model = new ModelFacade(client, transcript, {
            subject: {
              sessionId,
              sessionInstanceId: usageOwner.accountingSessionId,
              storageScopeId: createHash("sha256").update(sessions).digest("hex"),
              ephemeral: true,
            },
            signer,
            transcript,
            compositionDigest: "b".repeat(64),
            configVersion: 1,
            provider: client.provider,
            model: client.model,
          });
          const result = await withUsageOwner(usageOwner, () =>
            model.call("Synthetic system", [{ role: "user", content: input.prompt }], [], () => {}),
          );
          return { text: result.text, reason: "completed", usage: result.usage };
        } finally {
          release();
        }
      },
      cancel: async () => undefined,
      close: async () => {
        done();
      },
      rebind: (_sessionId, nextOwner) => {
        windowOwner = nextOwner.ownerWebContentsId;
      },
    },
    () => {},
  );
  return {
    owner,
    service,
    ownership,
    signer,
    ledger,
    completed,
    bridge,
    sends: () => sends,
    sessionId: () => sessionId,
    release: () => release(),
    mutate: (
      kind:
        | "unbound"
        | "worker"
        | "forgotten"
        | "window"
        | "dead"
        | "bridge"
        | "producer"
        | "project"
        | "cwd",
    ) => {
      if (kind === "unbound") bound = false;
      if (kind === "worker") generation++;
      if (kind === "forgotten") reservation = undefined;
      if (kind === "window") windowOwner = 10;
      if (kind === "dead") live = false;
      if (kind === "bridge") currentBridge = { ...bridge };
      if (kind === "producer") reservation!.producer = "unrelated-host-task";
      if (kind === "project") reservation!.mainRoot = join(root, "other-project");
      if (kind === "cwd") reservation!.cwd = join(root, "other-worktree");
    },
  };
}

test("a registered Panel task signs its ephemeral model request and reaches the real SDK transport", async () => {
  const f = fixture();
  const task = f.service.start(f.owner, { prompt: "Synthetic input", label: "Synthetic task" });
  await f.completed;
  expect(f.service.get(f.owner, task.id)).toMatchObject({
    status: "completed",
    result: { text: "ready" },
  });
  expect(f.sends()).toBe(1);
  expect(f.ledger.summary()).toMatchObject({ requests: 1, totalTokens: 10 });
  expect(f.ledger.summary().notSentRequests ?? 0).toBe(0);
  expect(f.ownership.hasActiveOwner(f.sessionId())).toBe(false);
  f.signer.dispose?.();
});

test("revocation during signing rejects before the SDK transport and records zero sent usage", async () => {
  const f = fixture({ revokeDuringSigning: true });
  const task = f.service.start(f.owner, { prompt: "Synthetic input", label: "Synthetic task" });
  await f.completed;
  expect(f.service.get(f.owner, task.id)).toMatchObject({ status: "failed" });
  expect(f.sends()).toBe(0);
  expect(f.ledger.summary()).toMatchObject({ requests: 1, notSentRequests: 1, totalTokens: 0 });
  f.signer.dispose?.();
});

for (const change of [
  "unbound",
  "worker",
  "forgotten",
  "window",
  "dead",
  "bridge",
  "producer",
  "project",
  "cwd",
] as const) {
  test(`a running Panel task loses signing authority after ${change}`, async () => {
    const f = fixture();
    f.service.start(f.owner, { prompt: "Synthetic input", label: "Synthetic task" });
    expect(f.ownership.hasActiveOwner(f.sessionId())).toBe(true);
    expect(f.ownership.hasActiveOwner("panel-task-unregistered")).toBe(false);
    f.mutate(change);
    expect(f.ownership.hasActiveOwner(f.sessionId())).toBe(false);
    await f.completed;
    expect(f.sends()).toBe(0);
    f.signer.dispose?.();
  });
}

test("task cancellation revokes signing authority before waiting for worker cancellation", async () => {
  const f = fixture();
  const task = f.service.start(f.owner, { prompt: "Synthetic input", label: "Synthetic task" });
  const cancelling = f.service.cancel(f.owner, task.id);
  expect(f.ownership.hasActiveOwner(f.sessionId())).toBe(false);
  await cancelling;
  await f.completed;
  expect(f.service.get(f.owner, task.id).status).toBe("cancelled");
  expect(f.sends()).toBe(0);
  f.signer.dispose?.();
});

test("task ownership survives a window rebind in the same workspace but refuses a changed execution cwd", async () => {
  for (const changeCwd of [false, true]) {
    const f = fixture();
    const task = f.service.start(f.owner, { prompt: "Synthetic input", label: "Synthetic task" });
    f.service.rebind({
      ...f.owner,
      guestId: 17,
      ownerWebContentsId: 19,
      bucket: "new-bucket",
      ...(changeCwd ? { cwd: join(f.owner.cwd, "other-worktree") } : {}),
    });
    expect(f.ownership.hasActiveOwner(f.sessionId())).toBe(!changeCwd);
    await f.completed;
    expect(f.sends()).toBe(changeCwd ? 0 : 1);
    expect(f.service.get(f.owner, task.id).status).toBe(changeCwd ? "failed" : "completed");
    f.signer.dispose?.();
  }
});

test("only a registered task can claim a worker and a stale release cannot revoke its replacement", async () => {
  const f = fixture();
  const unknownRelease = f.ownership.track("panel-task-unregistered", f.bridge);
  expect(f.ownership.hasActiveOwner("panel-task-unregistered")).toBe(false);
  unknownRelease();
  f.service.start(f.owner, { prompt: "Synthetic input", label: "Synthetic task" });
  expect(() => f.ownership.track(f.sessionId(), f.bridge)).toThrow("already has an active worker");
  f.release();
  const releaseReplacement = f.ownership.track(f.sessionId(), f.bridge);
  f.release();
  expect(f.ownership.hasActiveOwner(f.sessionId())).toBe(true);
  releaseReplacement();
  await f.completed;
  expect(f.sends()).toBe(0);
  f.signer.dispose?.();
});
