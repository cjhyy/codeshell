/**
 * Disk-backed session and attachment services.
 *
 * This entry intentionally excludes HTTP/WebSocket hosts and external-agent
 * composition so storage-only consumers do not evaluate transport modules.
 */
export * from "./attachment-service.js";
export * from "./client-message-id.js";
export * from "./image-byte-probe.js";
export * from "./sessions-service.js";
export * from "./session-titles-store.js";
export * from "./model-trace-history.js";
export * from "./panels/storage-store.js";
export { projectDiskSessionState } from "./disk-session-list.js";
export { listIndexedDiskSessions } from "./indexed-disk-sessions.js";
export { createSessionIndex, type SessionIndex } from "./session-index.js";
export { serveSessionIndexWorker } from "./session-index-host.js";
export { RoomHistoryReader } from "./mobile-remote/room-manager.js";
