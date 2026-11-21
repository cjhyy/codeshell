import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { BusinessMethods } from "./business-calls.js";
import type { SettingsChange } from "../../shared/settings-change.js";

export function settingsOperations(
  storage: Promise<StateStorage>,
  changed: (requestId: string, effects: SettingsChange) => void,
) {
  return {
    async "settings/patch"(input, grant) {
      const db = await storage;
      grant.assertCurrent();
      const result = await db.request<SettingsChange>("settings/patch", {
        input,
        permit: grant.permit,
      });
      if (!result) throw new Error("Settings storage unavailable");
      // A commit that beat document withdrawal must still refresh native consumers.
      changed(grant.requestId, result);
    },
  } satisfies Pick<BusinessMethods, "settings/patch">;
}
