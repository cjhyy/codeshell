import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type {
  MimiRouteCall,
  MimiConversationRoutes,
  MimiRouteMethod,
} from "../../shared/mimi-conversation-routes.js";
import { currentMimiRuleDocument } from "./mimi-rules-client.js";

export function nativeMimiConversationRoutes(call: CallShellBusiness): MimiConversationRoutes {
  const method =
    <K extends MimiRouteMethod>(name: K) =>
    async (
      ...args: Parameters<MimiConversationRoutes[K]>
    ): Promise<Awaited<ReturnType<MimiConversationRoutes[K]>>> => {
      const response = await call(
        "mimi/conversationRoutes",
        { method: name, args } as MimiRouteCall,
        currentMimiRuleDocument(),
      );
      return response.value as Awaited<ReturnType<MimiConversationRoutes[K]>>;
    };
  return {
    all: method("all"),
    notifyRoutesForSession: method("notifyRoutesForSession"),
    boundRoute: method("boundRoute"),
    routeById: method("routeById"),
    upsert: method("upsert"),
    leave: method("leave"),
    suspend: method("suspend"),
    recordInbound: method("recordInbound"),
    consumeStalePrompt: method("consumeStalePrompt"),
    expireStaleBoundRoutes: method("expireStaleBoundRoutes"),
  };
}
