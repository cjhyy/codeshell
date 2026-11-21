import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { BusinessMethods } from "./business-calls.js";
import type { ShellBusinessOperations } from "../../shared/shell-business-contracts.js";
import type { TrustLevel } from "../../main/trust-store.js";

export function projectTrustOperations(storage: Promise<StateStorage>) {
  return {
    async "trust/set"(input, grant) {
      const db = await storage;
      grant.assertCurrent();
      const ok = await db.request("trust/set", { input, permit: grant.permit });
      if (ok !== true) throw new Error("Project trust storage unavailable");
    },
    async "trust/readProjection"(input: ShellBusinessOperations["trust/readProjection"]["input"]) {
      const db = await storage;
      const value = await db.request<TrustLevel | "unknown">("trust/readProjection", input);
      if (!value) throw new Error("Project trust storage unavailable");
      return value;
    },
  } satisfies Pick<BusinessMethods, "trust/set" | "trust/readProjection">;
}
