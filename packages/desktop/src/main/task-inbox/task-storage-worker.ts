import { isMemoryCommand, writeHostedMemory } from "../hosted-memory.js";
import { StoredMimiWorkMemory } from "../../host/composition/mimi-work-memory.js";
import { dirname, join, isAbsolute } from "node:path";
import { StoredMimiRecords } from "../../host/composition/mimi-records.js";
import { attachCronStorage } from "../../host/automation/storage-owner.js";
import { MessagePort, workerData } from "node:worker_threads";
import { RunOperationStorage } from "../../host/composition/run-operation-storage.js";
import { installDefaultLinkProviders } from "@cjhyy/code-shell-server/links";
import { OperationBatches, type BatchPayload } from "../../host/composition/operation-batches.js";
import { isBatchCommand } from "../desktop-host/private-operations.js";
import {
  OperationStorage,
  type ResolveOperation,
  type PreparedOperationKey,
} from "../../host/composition/operation-storage.js";
import { isCatalogEdit } from "../../shared/catalog-edits.js";
import { writeHostedCatalog, commitPickedSourceUpload } from "../hosted-catalog-edits.js";
import { writeHostedProjectRegistry } from "../hosted-project-registry.js";
import { isProjectRegistryCommand } from "../../shared/project-registry-operations.js";
import { getTrust } from "../trust-store.js";
import { writeHostedProjectTrust } from "../hosted-project-trust.js";
import { writeHostedSettings } from "../hosted-settings-write.js";
import { SessionCatalogStore } from "../session-catalog-store.js";
import { claimBusinessCommit } from "../../host/composition/business-calls.js";
import type { SessionCatalogPatch, SessionIndex } from "../../shared/session-catalog.js";
import { StoredDesktopOutput, type OutputMutation } from "../desktop-host/stored-output.js";
import {
  credentialCommands,
  credentialFileCommand,
  type CredentialFileCommand,
} from "@cjhyy/code-shell-core/internal/storage";
import { serveSessionIndexWorker } from "@cjhyy/code-shell-server/storage";
import { createTaskInboxStorageHandlers } from "./task-projection-storage.js";

const port = workerData?.config?.schedulerPort;
if (port instanceof MessagePort) attachCronStorage(port);
const tasks = createTaskInboxStorageHandlers();
const catalog = new SessionCatalogStore();
let catalogRevision: number | undefined;
catalog.onChanged((snapshot) => {
  catalogRevision = snapshot.revision;
});
let output: StoredDesktopOutput | undefined;
let runLedger: RunOperationStorage | undefined;
let ledger: OperationStorage | undefined;
let mimiWork: StoredMimiWorkMemory | undefined;
let mimi: StoredMimiRecords | undefined;
let batches: OperationBatches | undefined;
// Link-backed source definitions are validated against this process-local registry.
installDefaultLinkProviders();
await serveSessionIndexWorker({
  ...tasks,
  async handle(ctx, command, payload) {
    if (isMemoryCommand(command))
      return writeHostedMemory(command, payload as Parameters<typeof writeHostedMemory>[1]);
    if (command === "mimi/records" || command === "mimi/workMemory") {
      const directory = workerData?.config?.taskInboxDirectory;
      if (typeof directory !== "string" || !isAbsolute(directory))
        throw Error("Desktop data directory unavailable");
      const root = join(dirname(directory), "pet");
      if (command === "mimi/workMemory") {
        mimiWork ??= new StoredMimiWorkMemory(root);
        return mimiWork.run(payload as Parameters<StoredMimiWorkMemory["run"]>[0]);
      }
      mimi ??= new StoredMimiRecords(root);
      return mimi.run(payload as Parameters<StoredMimiRecords["run"]>[0]);
    }
    if (command === "sources/commitPicked")
      return commitPickedSourceUpload(payload as Parameters<typeof commitPickedSourceUpload>[0]);
    if (isCatalogEdit(command))
      return writeHostedCatalog(command, payload as Parameters<typeof writeHostedCatalog>[1]);
    if (isProjectRegistryCommand(command))
      return writeHostedProjectRegistry(
        command,
        payload as Parameters<typeof writeHostedProjectRegistry>[1],
      );
    if (command === "trust/set")
      return writeHostedProjectTrust(payload as Parameters<typeof writeHostedProjectTrust>[0]);
    if (command === "trust/readProjection") return getTrust(payload as string);
    if (command === "settings/patch")
      return writeHostedSettings(payload as Parameters<typeof writeHostedSettings>[0]);
    if (command === "operations/run" || command === "operations/endRun") {
      runLedger ??= new RunOperationStorage(ctx.sessionsRoot);
      return command === "operations/endRun"
        ? runLedger.end((payload as { token: string }).token)
        : runLedger.run(payload as Parameters<RunOperationStorage["run"]>[0]);
    }
    if (isBatchCommand(command)) {
      batches ??= new OperationBatches(ctx.sessionsRoot);
      return batches.run(command, payload as BatchPayload);
    }
    if (
      command === "operations/wrappedKey" ||
      command === "operations/review" ||
      command === "operations/resolve"
    ) {
      ledger ??= new OperationStorage(ctx.sessionsRoot);
      if (command === "operations/wrappedKey") return ledger.wrappedKey();
      if (command === "operations/resolve") return ledger.resolve(payload as ResolveOperation);
      const { sessionId, key } = payload as { sessionId: string; key: PreparedOperationKey | null };
      return ledger.review(sessionId, key);
    }
    if (
      command === "catalog/load" ||
      command === "catalog/apply" ||
      command === "catalog/importLegacy"
    ) {
      const { input, permit } = payload as { input: unknown; permit: Int32Array };
      const commit = () => claimBusinessCommit(permit);
      if (command === "catalog/load") return { snapshot: await catalog.load(), changed: false };
      const before = catalogRevision;
      const snapshot =
        command === "catalog/apply"
          ? await catalog.commitPatch(input as SessionCatalogPatch, commit)
          : await catalog.commitLegacy(input as Record<string, SessionIndex>, commit);
      return { snapshot, changed: before !== catalogRevision };
    }
    if (command === "output/mutate" || command === "output/snapshot") {
      output ??= new StoredDesktopOutput(ctx.sessionsRoot);
      if (command === "output/mutate") return output.mutate(payload as OutputMutation);
      const { sessionId, sinceSeq } = payload as { sessionId: string; sinceSeq?: number };
      return output.snapshots.get(sessionId, sinceSeq);
    }
    if (credentialCommands.includes(command as CredentialFileCommand)) {
      const req = payload as { payload?: unknown; permit?: unknown };
      const config = ctx.config as { credentialsUserDir?: string } | undefined;
      return credentialFileCommand(
        config?.credentialsUserDir,
        command as CredentialFileCommand,
        req?.payload,
        req?.permit,
      );
    }
    return tasks.handle!(ctx, command, payload);
  },
});
