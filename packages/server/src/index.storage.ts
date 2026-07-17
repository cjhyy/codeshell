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
