/** Authenticated outbound device transport. Does not replace phone authorization. */
export * from "./remote-relay/protocol.js";
export * from "./remote-relay/byte-stream.js";
export * from "./remote-relay/connector.js";
// Enrollment must use the same persisted identity as the Host's Web descriptor.
export { environmentIdentity } from "./environment-identity.js";
