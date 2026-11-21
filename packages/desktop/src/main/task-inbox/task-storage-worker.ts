import { serveSessionIndexWorker } from "@cjhyy/code-shell-server/storage";
import { createTaskInboxStorageHandlers } from "./task-projection-storage.js";

await serveSessionIndexWorker(createTaskInboxStorageHandlers());
