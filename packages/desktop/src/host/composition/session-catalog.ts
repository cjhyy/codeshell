import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { SessionCatalogSnapshot } from "../../shared/session-catalog.js";
import type { BusinessMethods } from "./business-calls.js";

export function catalogOperations(
  storage: Promise<StateStorage>,
  changed: (snapshot: SessionCatalogSnapshot) => void,
) {
  async function call(command: string, input?: unknown, permit?: Int32Array) {
    const db = await storage;
    const result = await db.request<{ snapshot: SessionCatalogSnapshot; changed: boolean }>(
      command,
      { input, permit },
    );
    if (!result) throw new Error("Session catalog storage unavailable");
    if (result.changed) changed(result.snapshot);
    return result.snapshot;
  }
  return {
    "catalog/load": () => call("catalog/load"),
    "catalog/apply": (input, grant) => call("catalog/apply", input, grant.permit),
    "catalog/importLegacy": (input, grant) => call("catalog/importLegacy", input, grant.permit),
  } satisfies Pick<BusinessMethods, "catalog/load" | "catalog/apply" | "catalog/importLegacy">;
}
