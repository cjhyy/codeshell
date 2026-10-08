/** Trusted Host entry; deliberately exposes neither an Engine nor arbitrary run overrides. */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ClientDefaults, LLMConfig } from "../types.js";
import { createServer, createClient } from "../protocol/factories.js";
import { createInProcessTransport } from "../protocol/transport.js";
import { writeFileAtomic } from "../utils/file-mutex.js";
import {
  InstructionBindingStore,
  instructionHash,
  type InstructionSnapshot,
  type InstructionValidationReceipt,
} from "./instruction-bindings.js";

export async function runIsolatedInstruction(input: {
  cwd: string;
  llm: LLMConfig;
  clientDefaults: ClientDefaults;
  name: string;
  sourceRevision: string;
  body: string;
  task: string;
  signal?: AbortSignal;
  receiptRoot?: string;
}) {
  if (input.signal?.aborted) throw new Error("Isolated run cancelled");
  const snapshot: InstructionSnapshot = {
    bindingId: randomUUID(),
    cwd: realpathSync(input.cwd),
    provider: input.llm.provider,
    model: input.llm.model,
    name: input.name,
    sourceRevision: input.sourceRevision,
    body: input.body,
    bodyHash: instructionHash(input.body),
    revision: instructionHash(input.sourceRevision + "\0" + input.body),
  };
  const [serverTransport, clientTransport] = createInProcessTransport();
  const handle = createServer({
    transport: serverTransport,
    cwd: input.cwd,
    llm: input.llm,
    engineOverrides: {
      clientDefaults: input.clientDefaults,
      settingsScope: "isolated",
      isSubAgent: true,
      maxTurns: 4,
      enabledBuiltinTools: [],
      allowBackgroundShells: false,
      instructionSnapshots: [snapshot],
      skillAllowlist: [],
      headless: true,
    },
  });
  const client = createClient({ transport: clientTransport });
  const abort = () => {
    void client.cancel().catch(() => {});
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await client.run({
      sessionId: `isolated-${randomUUID()}`,
      task: input.task,
      cwd: input.cwd,
      behaviorMode: "isolatedTask",
      ephemeral: true,
      toolAllowlist: [],
      skillAllowlist: [],
      allowBackgroundShells: false,
      disableGoal: true,
    });
    const loaded = handle.engine.getLoadedInstructionSnapshots();
    const completed =
      result.reason === "completed" &&
      !input.signal?.aborted &&
      loaded.length === 1 &&
      loaded[0]?.revision === snapshot.revision;
    const receipt: InstructionValidationReceipt = {
      id: randomUUID(),
      cwd: realpathSync(input.cwd),
      provider: input.llm.provider,
      model: input.llm.model,
      name: input.name,
      sourceRevision: input.sourceRevision,
      bodyHash: snapshot.bodyHash,
      sessionId: result.sessionId,
      completed,
    };
    const store = new InstructionBindingStore(input.receiptRoot);
    writeFileAtomic(
      join(store.root, "receipts", `${receipt.id}.json`),
      JSON.stringify(receipt),
      0o600,
    );
    return { ...result, receipt };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    await handle.close();
    client.close();
    await handle.engine.dispose();
  }
}
