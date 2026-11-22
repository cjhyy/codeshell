import type { ConversationSessionRouteStore } from "../main/pet/conversation-session-route-store.js";

export const mimiRouteMethods = [
  "all",
  "notifyRoutesForSession",
  "boundRoute",
  "routeById",
  "upsert",
  "leave",
  "suspend",
  "recordInbound",
  "consumeStalePrompt",
  "expireStaleBoundRoutes",
] as const satisfies readonly (keyof ConversationSessionRouteStore)[];
export type MimiRouteMethod = (typeof mimiRouteMethods)[number];
export type MimiConversationRoutes = Pick<ConversationSessionRouteStore, MimiRouteMethod>;
export type MimiRouteCall = {
  [K in MimiRouteMethod]: { method: K; args: Parameters<MimiConversationRoutes[K]> };
}[MimiRouteMethod];
export interface MimiRouteReply {
  value: unknown;
}
