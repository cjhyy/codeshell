import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputAttachmentMeta } from "@cjhyy/code-shell-server/storage";
import { PetChatAttachmentContext } from "./pet-chat-attachment-context";
import {
  PetDispatchService,
  type PetAutoDelegation,
  type PetDispatchCommand,
} from "./pet-dispatch-service";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const snapshot: DesktopPetProjectionSnapshot = {
  version: 1,
  generation: 1,
  workerState: "active",
  observedAt: 1,
  sessions: [],
  pending: [],
};

type Chat = Extract<PetDispatchCommand, { type: "chat" }>;
type WorkerResult = { ok: true; result: Record<string, unknown> };

function source(senderId = "owner") {
  return {
    kind: "im-gateway" as const,
    channel: "wechat",
    target: "private-chat",
    senderId,
    isDirectMessage: true,
    capabilities: {
      inbound: { text: true as const, attachments: ["image"] as const },
      outbound: { text: true as const, button: "link" as const, attachments: [] },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mimi-dispatch-attachments-"));
  roots.push(root);
  const hostCwd = join(root, "no-repo");
  const path = ".code-shell/attachments/pet-one/a71cdd77b61e6d8c-wechat-image.jpg";
  const attachment: InputAttachmentMeta = {
    id: "att-original-image",
    sessionId: "pet-one",
    kind: "image",
    origin: "im-gateway",
    path,
    absPath: join(hostCwd, path),
    relPath: path,
    mime: "image/jpeg",
    originalName: "wechat-image.jpg",
    size: 1024,
    sha256: "a".repeat(64),
    createdAt: Date.now(),
    vision: { include: true },
  };
  return { root, hostCwd, attachment };
}

function delegationResult(params: Record<string, unknown>, objective: string): WorkerResult {
  const workspace = (params.petWorkspaces as Array<{ id: string; name: string }>).find(
    (entry) => entry.name === "CodeShell",
  )!;
  return {
    ok: true,
    result: {
      text: "正在派发排查任务。",
      reason: "completed",
      extensions: { pet: { workDelegation: { workspaceId: workspace.id, objective } } },
    },
  };
}

function createService(input: {
  root: string;
  hostCwd: string;
  starts: PetAutoDelegation[];
  worker: ConstructorParameters<typeof PetDispatchService>[0]["worker"];
  overrides?: Partial<ConstructorParameters<typeof PetDispatchService>[0]>;
}) {
  return new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
    aggregator: {
      getSnapshot: () => snapshot,
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    worker: input.worker,
    hostCwd: input.hostCwd,
    attachmentContext: new PetChatAttachmentContext(input.root),
    listWorkspaces: async () => [{ path: join(input.root, "codeshell"), name: "CodeShell" }],
    startWorkSession: async (request) => {
      input.starts.push(request);
      return { sessionId: `work-${input.starts.length}`, cwd: request.workspacePath! };
    },
    segmentController: {
      beginTurn: async () => undefined,
      requestContextClear: async () => undefined,
      completeSegmentClosure: async () => undefined,
      onDelegationClosed: async () => undefined,
    },
    ...input.overrides,
  });
}

function chat(message: string, id: string, attachments?: InputAttachmentMeta[]): Chat {
  return {
    type: "chat",
    message,
    clientMessageId: id,
    source: source(),
    ...(attachments ? { attachments } : {}),
  };
}

describe("Mimi attachment delegation context", () => {
  test.each([false, true])(
    "image then text then selection retains the source attachment (restart=%s)",
    async (restart) => {
      const data = await fixture();
      const starts: PetAutoDelegation[] = [];
      const worlds: Record<string, unknown>[] = [];
      const worker = {
        requestWorker: async (_method: string, params: Record<string, unknown>) => {
          worlds.push(JSON.parse(String(params.petRuntimeContext)));
          if (params.task === "3")
            return delegationResult(
              params,
              `读取这张 Windows 报错截图：\`${data.attachment.path}\``,
            );
          return { ok: true as const, result: { text: "请说明想检查什么。", reason: "completed" } };
        },
      };
      let service = createService({ ...data, starts, worker });
      expect(await service.dispatch(chat("", "image", [data.attachment]))).toMatchObject({
        ok: true,
        type: "chat",
      });
      if (restart) service = createService({ ...data, starts, worker });
      await service.dispatch(chat("为什么 Windows 报错", "question"));
      await service.dispatch(chat("3", "choice"));

      expect(starts).toHaveLength(1);
      expect(starts[0]?.inputAttachments).toEqual({
        cwd: data.hostCwd,
        sessionId: "pet-one",
        attachments: [data.attachment],
      });
      expect(worlds[1]?.inputAttachments).toEqual([
        {
          id: data.attachment.id,
          path: data.attachment.path,
          absPath: data.attachment.absPath,
          mime: data.attachment.mime,
        },
      ]);
    },
  );

  test("another IM sender cannot delegate a previous sender's image by naming its path", async () => {
    const data = await fixture();
    const starts: PetAutoDelegation[] = [];
    const worlds: Record<string, unknown>[] = [];
    const service = createService({
      ...data,
      starts,
      worker: {
        requestWorker: async (_method, params) => {
          worlds.push(JSON.parse(String(params.petRuntimeContext)));
          return params.task === "read"
            ? delegationResult(params, `读取 \`${data.attachment.absPath}\``)
            : { ok: true, result: { text: "收到截图。" } };
        },
      },
    });
    await service.dispatch(chat("", "image", [data.attachment]));
    await service.dispatch({ ...chat("read", "other-read"), source: source("another-sender") });
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toHaveProperty("inputAttachments");
    expect(worlds[1]).not.toHaveProperty("inputAttachments");
  });

  test("separately completed image turns both remain available to a later comparison", async () => {
    const data = await fixture();
    const secondImage: InputAttachmentMeta = {
      ...data.attachment,
      id: "att-second-image",
      path: data.attachment.path.replace("a71cdd77b61e6d8c", "b71cdd77b61e6d8c"),
      absPath: data.attachment.absPath.replace("a71cdd77b61e6d8c", "b71cdd77b61e6d8c"),
      relPath: data.attachment.relPath!.replace("a71cdd77b61e6d8c", "b71cdd77b61e6d8c"),
      sha256: "b".repeat(64),
    };
    const starts: PetAutoDelegation[] = [];
    const service = createService({
      ...data,
      starts,
      worker: {
        requestWorker: async (_method, params) =>
          params.task === "compare"
            ? delegationResult(
                params,
                `对比两张报错截图：\`${data.attachment.path}\` 和 \`${secondImage.absPath}\`。`,
              )
            : { ok: true, result: { text: "收到截图。", reason: "completed" } },
      },
    });
    await service.dispatch(chat("第一张截图", "first-image", [data.attachment]));
    await service.dispatch(chat("第二张截图", "second-image", [secondImage]));
    await service.dispatch(chat("compare", "compare-both"));

    expect(starts).toHaveLength(1);
    expect(starts[0]?.inputAttachments).toMatchObject({
      cwd: data.hostCwd,
      sessionId: "pet-one",
    });
    expect(starts[0]?.inputAttachments?.attachments).toHaveLength(2);
    expect(starts[0]?.inputAttachments?.attachments).toEqual(
      expect.arrayContaining([data.attachment, secondImage]),
    );
  });

  test("clear removes attachment context before the next delegation", async () => {
    const data = await fixture();
    const starts: PetAutoDelegation[] = [];
    const service = createService({
      ...data,
      starts,
      worker: {
        requestWorker: async (_method, params) =>
          params.task === "read"
            ? delegationResult(params, `读取 \`${data.attachment.path}\``)
            : { ok: true, result: { text: "收到截图。" } },
      },
    });
    await service.dispatch(chat("", "image", [data.attachment]));
    expect(await service.dispatch(chat("/clear", "clear"))).toMatchObject({
      ok: true,
      type: "chat",
      contextCleared: true,
    });
    await service.dispatch(chat("read", "read-after-clear"));
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toHaveProperty("inputAttachments");
  });

  test.each([true, false])(
    "only consumed steer images join the leader's delegation (consumed=%s)",
    async (consumed) => {
      const data = await fixture();
      const starts: PetAutoDelegation[] = [];
      const firstRunStarted = deferred<void>();
      const firstRunDone = deferred<void>();
      const steerAccepted = deferred<void>();
      let outbound:
        | ((line: string, snapshotEntry?: { sessionId: string; event: unknown }) => void)
        | undefined;
      const service = createService({
        ...data,
        starts,
        worker: {
          subscribeOutbound: (listener) => {
            outbound = listener;
            return () => undefined;
          },
          requestWorker: async (method, params) => {
            if (method === "agent/steer") {
              if (consumed)
                outbound?.("", {
                  sessionId: "pet-one",
                  event: { type: "steer_injected", id: params.id, text: params.text },
                });
              steerAccepted.resolve(undefined);
              return { ok: true, result: { accepted: true } };
            }
            if (method === "agent/unsteer") return { ok: true, result: { removed: true } };
            if (params.task === "leader") {
              firstRunStarted.resolve(undefined);
              await firstRunDone.promise;
              return delegationResult(params, `读取 \`${data.attachment.path}\``);
            }
            return { ok: true, result: { text: "下一轮已收到图片。", reason: "completed" } };
          },
        },
      });
      const leader = service.dispatch(chat("leader", "leader"));
      await firstRunStarted.promise;
      const follower = service.dispatch(chat("补充这张截图", "follower", [data.attachment]));
      await steerAccepted.promise;
      firstRunDone.resolve(undefined);
      const [leaderResult, followerResult] = await Promise.all([leader, follower]);

      expect(leaderResult).toMatchObject({ ok: true, type: "chat" });
      expect(followerResult).toMatchObject({
        ok: true,
        type: "chat",
        inputDisposition: consumed ? "steered" : "turn",
      });
      expect(starts).toHaveLength(1);
      if (consumed) expect(starts[0]?.inputAttachments?.attachments).toEqual([data.attachment]);
      else expect(starts[0]).not.toHaveProperty("inputAttachments");
    },
  );

  test("finishing an older image turn does not replace a queued turn's newer attachment context", async () => {
    const data = await fixture();
    const nextAttachment: InputAttachmentMeta = {
      ...data.attachment,
      id: "att-next-image",
      path: data.attachment.path.replace("a71cdd77b61e6d8c", "b71cdd77b61e6d8c"),
      absPath: data.attachment.absPath.replace("a71cdd77b61e6d8c", "b71cdd77b61e6d8c"),
      relPath: data.attachment.relPath!.replace("a71cdd77b61e6d8c", "b71cdd77b61e6d8c"),
      sha256: "b".repeat(64),
    };
    const starts: PetAutoDelegation[] = [];
    const firstRunStarted = deferred<void>();
    const firstRunDone = deferred<void>();
    const steerAccepted = deferred<void>();
    const service = createService({
      ...data,
      starts,
      worker: {
        requestWorker: async (method, params) => {
          if (method === "agent/steer") {
            steerAccepted.resolve(undefined);
            return { ok: true, result: { accepted: true } };
          }
          if (method === "agent/unsteer") return { ok: true, result: { removed: true } };
          if (params.task === "leader") {
            firstRunStarted.resolve(undefined);
            await firstRunDone.promise;
            return delegationResult(params, `读取第一张图 \`${data.attachment.path}\``);
          }
          if (params.task === "read-next")
            return delegationResult(params, `读取第二张图 \`${nextAttachment.path}\``);
          return { ok: true, result: { text: "已收到第二张图。", reason: "completed" } };
        },
      },
    });
    const leader = service.dispatch(chat("leader", "first-image", [data.attachment]));
    await firstRunStarted.promise;
    const follower = service.dispatch(chat("这是第二张图", "second-image", [nextAttachment]));
    await steerAccepted.promise;
    firstRunDone.resolve(undefined);
    await Promise.all([leader, follower]);
    await service.dispatch(chat("read-next", "read-next"));

    expect(starts).toHaveLength(2);
    expect(starts[0]?.inputAttachments?.attachments).toEqual([data.attachment]);
    expect(starts[1]?.inputAttachments?.attachments).toEqual([nextAttachment]);
  });

  test("a path the user never attached is not forwarded even inside the staging directory", async () => {
    const data = await fixture();
    const starts: PetAutoDelegation[] = [];
    const forged = data.attachment.path.replace("a71cdd77b61e6d8c", "f00dcafe00000000");
    const service = createService({
      ...data,
      starts,
      worker: {
        requestWorker: async (_method, params) =>
          params.task === "read"
            ? delegationResult(params, `读取 \`${forged}\` 和 \`${join(data.hostCwd, forged)}\``)
            : { ok: true, result: { text: "收到截图。", reason: "completed" } },
      },
    });
    await service.dispatch(chat("", "image", [data.attachment]));
    await service.dispatch(chat("read", "read-forged"));
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toHaveProperty("inputAttachments");
  });

  test("an unavailable attachment context never drops the message or wedges later chats", async () => {
    const data = await fixture();
    const starts: PetAutoDelegation[] = [];
    const failing = {
      remember: async () => {
        throw new Error("disk full");
      },
      list: async () => {
        throw new Error("disk full");
      },
      clear: async () => undefined,
    };
    const service = createService({
      ...data,
      starts,
      overrides: { attachmentContext: failing },
      worker: {
        requestWorker: async (_method, params) =>
          params.task === "read now"
            ? delegationResult(params, `读取 \`${data.attachment.path}\``)
            : { ok: true, result: { text: "好的。", reason: "completed" } },
      },
    });
    expect(await service.dispatch(chat("read now", "image-turn", [data.attachment]))).toMatchObject(
      { ok: true, type: "chat" },
    );
    expect(starts[0]?.inputAttachments?.attachments).toEqual([data.attachment]);
    expect(await service.dispatch(chat("还在吗", "after-failure"))).toMatchObject({
      ok: true,
      type: "chat",
    });
  });

  test("a selection over the transfer limits fails only that launch with a handoff error", async () => {
    const data = await fixture();
    const images = Array.from({ length: 9 }, (_, index) => {
      const prefix = `${index}`.padStart(16, "c");
      return {
        ...data.attachment,
        id: `att-limit-${index}`,
        path: data.attachment.path.replace("a71cdd77b61e6d8c", prefix),
        absPath: data.attachment.absPath.replace("a71cdd77b61e6d8c", prefix),
        relPath: data.attachment.relPath!.replace("a71cdd77b61e6d8c", prefix),
      };
    });
    const starts: PetAutoDelegation[] = [];
    const service = createService({
      ...data,
      starts,
      worker: {
        requestWorker: async (_method, params) =>
          params.task === "compare all"
            ? delegationResult(
                params,
                `对比这些截图：${images.map((image) => `\`${image.path}\``).join("、")}`,
              )
            : { ok: true, result: { text: "无法派发。", reason: "completed" } },
      },
    });
    const result = await service.dispatch(chat("compare all", "too-many", images));
    expect(result).toMatchObject({ ok: true, type: "chat" });
    expect(starts).toEqual([]);
    expect(result.ok && result.type === "chat" ? result.delegationError : undefined).toContain(
      "Mimi image handoff failed",
    );
  });

  test("a host wake neither sees nor forwards the conversation's retained images", async () => {
    const data = await fixture();
    const starts: PetAutoDelegation[] = [];
    const worlds: Record<string, unknown>[] = [];
    const wakeSnapshot: DesktopPetProjectionSnapshot = {
      ...snapshot,
      sessions: [
        {
          agentSessionId: "original",
          title: "original",
          runState: "dormant",
          queueDepth: 0,
          pendingDecisionCount: 0,
          lastActivityAt: 1,
          freshness: { source: "disk", observedAt: 1, workerState: "active" },
        },
      ],
    };
    const service = createService({
      ...data,
      starts,
      overrides: {
        aggregator: {
          getSnapshot: () => wakeSnapshot,
          resolveNavigation: async () => ({ status: "not-found" }),
        },
        listReusableSessions: async () => [
          {
            sessionId: "original",
            title: "original",
            workspacePath: join(data.root, "codeshell"),
            updatedAt: 1,
          },
        ],
        startWorkSession: async (request) => {
          starts.push(request);
          return { sessionId: request.targetSessionId!, cwd: request.workspacePath! };
        },
      },
      worker: {
        requestWorker: async (_method, params) => {
          worlds.push(JSON.parse(String(params.petRuntimeContext)));
          if (!String(params.clientMessageId).startsWith("pet-followup-"))
            return { ok: true, result: { text: "收到截图。", reason: "completed" } };
          const profile = params.profileParams as {
            workspaces: Array<{ id: string; name: string }>;
          };
          return {
            ok: true,
            result: {
              text: "继续原任务。",
              reason: "completed",
              extensions: {
                pet: {
                  workDelegation: {
                    workspaceId: profile.workspaces.find((row) => row.name === "CodeShell")!.id,
                    objective: `继续核对 \`${data.attachment.path}\``,
                    reusableSessionId: sessionSelectorId("original"),
                    continuationEvidence: {
                      priorThread: "original",
                      reason: "继续核对该截图任务的剩余部分",
                    },
                  },
                },
              },
            },
          };
        },
      },
    });
    await service.dispatch({
      type: "chat",
      message: "截图",
      clientMessageId: "desktop-image",
      attachments: [data.attachment],
    });
    expect(worlds[0]?.inputAttachments).toHaveLength(1);
    const wake = await service.wakeFollowUp({
      id: `registered-followup-${"a".repeat(24)}`,
      operationKey: "op",
      registrationKey: "b".repeat(64),
      revision: 1,
      title: "核对",
      text: "继续核对",
      wakeAt: Date.now() - 1_000,
      catchUpUntil: Date.now() + 60_000,
      timezone: "Asia/Singapore",
      intent: "resume",
      missedPolicy: "fire-once",
      status: "open",
      createdAt: 1,
      updatedAt: 1,
      sourceSessionId: "original",
      wake: { revision: 1, status: "claimed", claimedAt: 1 },
    });
    expect(wake.launched).toBe(true);
    expect(worlds.at(-1)).not.toHaveProperty("inputAttachments");
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toHaveProperty("inputAttachments");
  });
});
