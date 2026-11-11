import { join } from "node:path";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import { createReplyModels, type ExternalReplyModel } from "./pet-notice-reply-models.js";
import type { PetNoticeWiring } from "./pet-notice-wiring-types.js";
import { createPetProactive, type PetProactive } from "./pet-proactive.js";
import { PetProactiveStateStore } from "./pet-proactive-state.js";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator.js";

/** A brief's write-up is longer than a reply reading. */
const BRIEF_MAX_TOKENS = 2_000;

/**
 * Main's composition of Mimi's briefs and heartbeat over the notice wiring:
 * its rule table, ledger, settings and router; state in
 * `<userData>/pet/proactive.json`; each question snapshots Mimi's effective provider.
 */
export function wirePetProactive(input: {
  notices: Pick<
    PetNoticeWiring,
    | "ruleStore"
    | "ledger"
    | "settings"
    | "onSettingsChange"
    | "submitNotice"
    | "wasSessionViewedSince"
  >;
  userDataDir: string;
  /** Settings cwd for the models. */
  cwd: string;
  externalReplyModel?: ExternalReplyModel;
  tasks(): readonly PetLongTask[];
  projection(): Pick<DesktopPetProjectionSnapshot, "sessions" | "pending">;
  log(event: string, data: Record<string, unknown>): void;
}): PetProactive {
  const { notices } = input;
  return createPetProactive({
    rules: notices.ruleStore,
    state: new PetProactiveStateStore(join(input.userDataDir, "pet", "proactive.json")),
    ledger: notices.ledger,
    tasks: input.tasks,
    sessions: () => input.projection().sessions,
    pending: () => input.projection().pending,
    wasSessionViewedSince: notices.wasSessionViewedSince,
    settings: notices.settings,
    onSettingsChange: notices.onSettingsChange,
    submit: notices.submitNotice,
    models: () =>
      createReplyModels(input.cwd, {
        maxTokens: BRIEF_MAX_TOKENS,
        external: input.externalReplyModel,
      }),
    log: input.log,
  });
}
