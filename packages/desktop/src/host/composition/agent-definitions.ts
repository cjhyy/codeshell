import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { AgentDefinitionChanges } from "../../shared/agent-definitions.js";
import type { BusinessGrant } from "./business-calls.js";

export function agentDefinitionChanges(storage: Promise<StateStorage>) {
  const change =
    <K extends keyof AgentDefinitionChanges>(method: K) =>
    async (input: AgentDefinitionChanges[K]["input"], grant: BusinessGrant) => {
      const db = await storage;
      grant.assertCurrent();
      const reply = await db.request<{ result: AgentDefinitionChanges[K]["result"] }>(method, {
        input,
        permit: grant.permit,
      });
      if (!reply) throw Error("Agent definition storage unavailable");
      return reply.result;
    };
  return { "agents/save": change("agents/save"), "agents/delete": change("agents/delete") };
}
