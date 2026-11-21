import { StoredDesktopOutput, type OutputMutation } from "../desktop-host/stored-output.js";
import {
  credentialCommands,
  credentialFileCommand,
  type CredentialFileCommand,
} from "@cjhyy/code-shell-core/internal/storage";
import { serveSessionIndexWorker } from "@cjhyy/code-shell-server/storage";
import { createTaskInboxStorageHandlers } from "./task-projection-storage.js";

const tasks = createTaskInboxStorageHandlers();
let output: StoredDesktopOutput | undefined;
await serveSessionIndexWorker({
  ...tasks,
  handle(ctx, command, payload) {
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
