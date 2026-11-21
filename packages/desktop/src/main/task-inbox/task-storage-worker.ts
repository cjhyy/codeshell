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

const tasks = createTaskInboxStorageHandlers();
const catalog = new SessionCatalogStore();
let catalogRevision: number | undefined;
catalog.onChanged((snapshot) => {
  catalogRevision = snapshot.revision;
});
let output: StoredDesktopOutput | undefined;
await serveSessionIndexWorker({
  ...tasks,
  async handle(ctx, command, payload) {
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
