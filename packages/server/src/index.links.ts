/** Pure Node Link management shared by Desktop and standalone hosts. */
export * from "./links/catalog.js";
export * from "./links/device-oauth.js";
export * from "./links/service.js";
export * from "./links/types.js";
export * from "./links/http.js";
export type {
  LinkAuthorizationDiagnostic,
  LinkAuthorizationDiagnosticStage,
  LinkAuthorizationDiagnosticCode,
  LinkAuthorizationDiagnosticSink,
} from "./links/diagnostics.js";

export * from "./links/remote-configuration.js";
export {
  readRemoteProviderCatalog,
  readRemoteProviderCapabilities,
  RemoteLinkCatalogError,
  type RemoteLinkCatalogFailureReason,
  type RemoteProviderCapabilities,
} from "./links/remote-catalog.js";
