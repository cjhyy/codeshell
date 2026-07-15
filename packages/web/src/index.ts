/**
 * @cjhyy/code-shell-web — the browser-side logic layer of the CodeShell web
 * client (extracted from packages/desktop src/mobile). Zero Electron, zero
 * preload-bridge globals, zero @cjhyy/code-shell-core runtime imports:
 * everything here runs in a plain browser (localStorage/WebSocket/navigator).
 * Protocol types come from @cjhyy/code-shell-core (type-only, erased).
 *
 * The desktop mobile UI (packages/desktop/src/mobile) renders on top of this;
 * a future standalone browser client is meant to grow from this package.
 */

// ── Hooks: remote-app state machine + reconnecting socket ───────────────────
export {
  useRemoteApp,
  type CcCliKind,
  type PendingApproval,
  type RemoteApp,
} from "./hooks/useRemoteApp.js";
export {
  useRemoteSocket,
  type ConnStatus,
  type ResyncReason,
  type RemoteSocket,
  type RemoteSocketHandlers,
} from "./hooks/useRemoteSocket.js";
export * from "./hooks/remoteAppSync.js";

// ── Stream folding (shared with the desktop renderer's CC room view) ────────
export * from "./lib/streamReducer.js";
export * from "./lib/messageMappers.js";

// ── Pure helpers ─────────────────────────────────────────────────────────────
export * from "./lib/riskClassify.js";
export * from "./lib/format.js";
export * from "./lib/storage.js";
export * from "./lib/pairing.js";
export * from "./lib/deviceCredential.js";
export * from "./lib/mobileAttachments.js";
export * from "./lib/uiLanguage.js";

// ── i18n: mobile namespace dict + zh-fallback translate ─────────────────────
export { mobile } from "./i18n/mobile.js";
export {
  translate,
  t,
  webMessages,
  type WebTranslationKey,
  type WebTranslateParams,
} from "./i18n/translate.js";
