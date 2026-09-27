/** Single-owner HTTP authentication for trusted service compositions; no worker is started. */
export {
  createHubAuth,
  HUB_SESSION_COOKIE,
  type HubAuth,
  type HubAuthOptions,
} from "./hub/auth-http.js";
export type { HubSession } from "./hub/auth-store.js";
