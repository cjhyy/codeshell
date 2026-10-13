/** Ready-made headless HTTP/WebSocket host and CLI composition helpers. */
export * from "./serve/headless-server.js";
export {
  startProjectControlServer,
  type ProjectControlServerOptions,
} from "./project-runtime/control-server.js";
export { CLOUD_MANAGEMENT_AUTHORITY_VERSION } from "./project-runtime/cloud-account-auth.js";
export { CLOUD_BROWSER_AUTHORITY_VERSION } from "./project-runtime/cloud-browser-auth.js";
export {
  adoptCloudAccount,
  inspectCloudAccountAdoption,
  type CloudAccountAdoptionOptions,
} from "./project-runtime/account-adoption.js";
export type {
  CloudAccountAuthority,
  CloudAccountPrincipal,
  CloudManagementSession,
} from "./project-runtime/control-authority.js";
export {
  parseServeArgs,
  resolveWebAppRoot,
  resolveWorkerCapabilityModules,
  resolveWorkerEntry,
  runServeCli,
} from "./serve/cli.js";
export {
  backupProjectInstallation,
  restoreProjectInstallation,
  type ProjectBackupOptions,
  type ProjectRestoreOptions,
} from "./project-runtime/backup.js";

export {
  readProjectSeccompProfile,
  type ProjectSeccompProfile,
} from "./project-runtime/seccomp.js";
