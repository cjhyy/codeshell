import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_CHANNEL_CAPABILITIES } from "@cjhyy/code-shell-chat";
import {
  PetDispatchService,
  type PetHostActionContext,
  type PetWorldContextInput,
} from "./pet-dispatch-service.js";
import { PetContextLinkStore, petContextOriginForSource } from "./pet-context-links.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const source = {
  kind: "im-gateway" as const,
  channel: "wechat",
  target: "private-target",
  senderId: "private-owner",
  isDirectMessage: true,
  capabilities: BUILTIN_CHANNEL_CAPABILITIES.wechat,
};
const task = {
  taskId: "task-live",
  sessionId: "work-live",
  objective: "Verify invoice exports against original checksum",
};

describe("Mimi host-grounded recall input", () => {
  test("re-resolves linked task identity after restart and reserves the trusted source view", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimi-context-dispatch-"));
    roots.push(root);
    const path = join(root, "context-links.json");
    const originRef = petContextOriginForSource(source);
    await new PetContextLinkStore(path).record({
      clientMessageId: "old-input",
      originRef,
      eventKind: "chat",
      at: 1,
      tasks: [
        task,
        { taskId: "task-deleted", sessionId: "deleted", objective: "Obsolete objective" },
      ],
    });
    const inputs: PetWorldContextInput[] = [];
    const worlds: Record<string, unknown>[] = [];
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "mimi-shared" }) },
      aggregator: {
        getSnapshot: () => ({
          version: 1,
          generation: 1,
          observedAt: 1,
          workerState: "active",
          sessions: [],
          pending: [],
        }),
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      hostCwd: root,
      contextLinks: new PetContextLinkStore(path),
      longTasks: { context: () => ({ active: [task], recent: [] }) },
      worldContext: (input) => {
        inputs.push(input);
        return {
          memories: [{ id: "old-fact", text: "Invoice export checksum" }],
          contextAssociation: { originRef: "forged" },
        };
      },
      worker: {
        requestWorker: async (_method, params) => {
          worlds.push(JSON.parse(String(params.petRuntimeContext)));
          expect(params.sessionId).toBe("mimi-shared");
          return { ok: true, result: { text: "Ready" } };
        },
      },
    });
    await service.dispatch({
      type: "chat",
      message: "继续核对",
      clientMessageId: "new-input",
      source,
    });
    expect(inputs[0]).toMatchObject({
      message: "继续核对",
      originRef,
      groundedTasks: [task],
      associationState: "available",
    });
    expect(worlds[0]?.contextAssociation).toMatchObject({ originRef, groundedTasks: [task] });
    expect(worlds[0]?.memories).toEqual([{ id: "old-fact", text: "Invoice export checksum" }]);
    expect(JSON.stringify(worlds[0])).not.toContain(source.target);
    expect(JSON.stringify(worlds[0])).not.toContain(source.senderId);
    expect(
      (await new PetContextLinkStore(path).query({ clientMessageId: "new-input" })).entries[0]
        ?.tasks,
    ).toEqual([task]);

    await service.dispatch({
      type: "chat",
      message: "新的桌面问题",
      clientMessageId: "desktop-input",
    });
    expect(inputs[1]).toMatchObject({ originRef: { kind: "desktop" }, groundedTasks: [] });
  });

  test("index failures degrade association coverage without guessing an objective or blocking chat", async () => {
    let inputSeen: PetWorldContextInput | undefined;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "mimi" }) },
      aggregator: {
        getSnapshot: () => ({
          version: 1,
          generation: 1,
          observedAt: 1,
          workerState: "active",
          sessions: [],
          pending: [],
        }),
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      hostCwd: "/safe",
      contextLinks: {
        query: async () => {
          throw new Error("unreadable index");
        },
        record: async () => {
          throw new Error("unwritable index");
        },
      },
      longTasks: { context: () => ({ active: [task] }) },
      worldContext: (input) => {
        inputSeen = input;
        return {};
      },
      worker: { requestWorker: async () => ({ ok: true, result: { text: "Ready" } }) },
    });
    const result = await service.dispatch({
      type: "chat",
      message: "继续",
      clientMessageId: "input",
      source,
    });
    expect(result.ok).toBe(true);
    expect(inputSeen).toMatchObject({ groundedTasks: [], associationState: "unavailable" });
  });

  test("links newly accepted task IDs and passes their real association to memory actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimi-context-launch-"));
    roots.push(root);
    const contextLinks = new PetContextLinkStore(join(root, "context-links.json"));
    let memoryContext: PetHostActionContext | undefined;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "mimi" }) },
      aggregator: {
        getSnapshot: () => ({
          version: 1,
          generation: 1,
          observedAt: 1,
          workerState: "active",
          sessions: [],
          pending: [],
        }),
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      hostCwd: root,
      contextLinks,
      listWorkspaces: async () => [{ path: root, name: "Invoices" }],
      startWorkSession: async () => ({ sessionId: task.sessionId, taskId: task.taskId, cwd: root }),
      hostActions: {
        memory: async (_payload, context) => {
          memoryContext = context;
          return { remembered: true };
        },
      },
      worker: {
        requestWorker: async (_method, params) => {
          if (params.injected) return { ok: true, result: { text: "Accepted" } };
          const workspace = (params.petWorkspaces as Array<{ id: string }>)[0]!;
          return {
            ok: true,
            result: {
              text: "Starting",
              extensions: {
                pet: {
                  workDelegation: { workspaceId: workspace.id, objective: task.objective },
                  hostActions: [
                    { kind: "memory", payload: { action: "remember", text: "Keep checksum" } },
                  ],
                },
              },
            },
          };
        },
      },
    });
    const result = await service.dispatch({
      type: "chat",
      message: "核查发票并记住校验要求",
      clientMessageId: "new-task-input",
      source,
    });
    expect(result).toMatchObject({ ok: true, delegation: { taskId: task.taskId } });
    expect(memoryContext).toMatchObject({
      originRef: petContextOriginForSource(source),
      groundedTasks: [task],
    });
    expect((await contextLinks.query({ taskId: task.taskId })).entries).toMatchObject([
      { clientMessageId: "new-task-input", tasks: [task] },
    ]);
  });
});
