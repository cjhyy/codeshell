import { currentMimiRuleDocument } from "./mimi-rules-client.js";
import type { MimiProactiveAccess } from "../../shared/mimi-proactive-state.js";
import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
export function nativeMimiProactiveState(call: CallShellBusiness): MimiProactiveAccess {
  return {
    async read() {
      const reply = await call("mimi/proactiveState", { type: "read" }, currentMimiRuleDocument());
      if (!("state" in reply)) throw Error("Missing Mimi heartbeat state");
      return reply.state;
    },
    async change(input) {
      const reply = await call("mimi/proactiveState", input, currentMimiRuleDocument());
      if (!("committed" in reply)) throw Error("Missing Mimi heartbeat result");
      return reply.committed;
    },
  };
}
