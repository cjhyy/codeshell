// Native fixture bundles the real Main adapters; public compiled packages stay external.
export { ExternalRuntimeService } from "../../packages/desktop/src/main/external-runtime-service.js";
export { SessionSnapshotStore } from "../../packages/desktop/src/main/SessionSnapshotStore.js";
export { publishOwnedExternalStream } from "../../packages/desktop/src/main/owned-external-stream.js";
export { registerSessionTranscriptIpc } from "../../packages/desktop/src/main/session-transcript-ipc.js";
export { recoverDesktopOutputJournal } from "../../packages/desktop/src/renderer/app/outputJournalRecovery.js";
export { createTaskInboxSources } from "../../packages/desktop/src/main/task-inbox/task-inbox-sources.js";
export { ExternalRuntimeSessionRecorder } from "../../packages/desktop/src/main/external-runtime-state.js";
