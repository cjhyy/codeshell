import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentClient,
  AgentServer,
  ChatSessionManager,
  Engine,
  compileComposition,
  createInProcessTransport,
} from "@cjhyy/code-shell-core";
import {
  LLMClientBase,
  registerProvider,
  type CreateMessageOptions,
  type LLMResponse,
} from "@cjhyy/code-shell-core/extension";
import { createPetModule } from "./capability.js";
import {
  GET_PET_PROJECTION_SNAPSHOT_METHOD,
  PET_PROJECTION_DELTA_METHOD,
  type PetProjectionDelta,
  type PetProjectionSnapshotResult,
} from "./protocol.js";
import type { PetSessionProjection } from "./types.js";

const provider = "pet-projection-first-run-fixture";
class ProjectionFixtureClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12 };
    this.recordUsage(usage, options);
    return { text: "Reply complete", toolCalls: [], stopReason: "stop", usage };
  }
}
registerProvider(provider, ProjectionFixtureClient);

test("real first Mimi run removes its pre-persistence projection from the live work list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-projection-first-run-"));
  const sessionId = "pet-first-run";
  const statePath = join(dir, "sessions", sessionId, "state.json");
  const modules = [createPetModule()];
  const manager = new ChatSessionManager({
    runtime: {} as never,
    engineFactory: (slice) => {
      const engine = new Engine({
        ...slice,
        llm: { provider, model: "fixture", apiKey: "offline-fixture" } as never,
        cwd: dir,
        modules,
        sessionStorageDir: join(dir, "sessions"),
        settingsScope: "isolated",
        headless: true,
      });
      (engine as any).hooks.clear();
      return engine;
    },
  });
  const [clientTransport, serverTransport] = createInProcessTransport();
  const server = new AgentServer({
    chatManager: manager,
    transport: serverTransport,
    composition: compileComposition({ modules }),
  });
  const client = new AgentClient({ transport: clientTransport });
  const projected = new Map<string, PetSessionProjection>();
  const deltas: PetProjectionDelta[] = [];
  client.onExtensionNotification(PET_PROJECTION_DELTA_METHOD, (raw) => {
    const delta = raw as unknown as PetProjectionDelta;
    deltas.push(delta);
    if (delta.kind === "session-upsert") projected.set(delta.session.agentSessionId, delta.session);
    if (delta.kind === "session-remove") projected.delete(delta.sessionId);
  });
  try {
    expect(existsSync(statePath)).toBe(false);
    const first = await client.run({
      sessionId,
      task: "Hello Mimi",
      clientMessageId: "first-input",
      kind: "pet",
      behaviorMode: "pet",
    });
    expect(first.text).toBe("Reply complete");
    expect(JSON.parse(readFileSync(statePath, "utf8")).kind).toBe("pet");
    // Prove this fixture crossed the real timing window: the start boundary
    // ran before Engine persisted kind=pet. Delta consumers need a withdrawal.
    expect(deltas.some((delta) => delta.kind === "session-upsert")).toBe(true);
    expect(deltas.at(-1)).toMatchObject({ kind: "session-remove", sessionId });
    expect(projected.size).toBe(0);
    const snapshot = (await client.requestExtension(
      GET_PET_PROJECTION_SNAPSHOT_METHOD,
    )) as PetProjectionSnapshotResult;
    expect(snapshot.sessions).toEqual([]);
    const deltaCount = deltas.length;
    await client.run({
      sessionId,
      task: "Second input",
      clientMessageId: "second-input",
      kind: "pet",
      behaviorMode: "pet",
    });
    expect(projected.size).toBe(0);
    expect(deltas.length).toBe(deltaCount);
  } finally {
    server.close();
    client.close();
    await manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
