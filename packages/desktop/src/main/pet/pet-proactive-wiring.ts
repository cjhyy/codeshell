import type { PetLongTask } from "@cjhyy/code-shell-pet";
import {
  createReplyModels,
  type ExternalReplyModel,
  type ReplyModelOptions,
} from "./pet-notice-reply-models.js";
import type { PetNoticeWiring } from "./pet-notice-wiring-types.js";
import { createPetProactive, type PetProactive } from "./pet-proactive.js";
import type { MimiProactiveAccess } from "../../shared/mimi-proactive-state.js";
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
  state: MimiProactiveAccess;
  /** Settings cwd for the models. */
  cwd: string;
  externalReplyModel?: ExternalReplyModel;
  accounting?: ReplyModelOptions["accounting"];
  tasks(): readonly PetLongTask[] | Promise<readonly PetLongTask[]>;
  projection(): Pick<DesktopPetProjectionSnapshot, "sessions" | "pending">;
  log(event: string, data: Record<string, unknown>): void;
}): PetProactive {
  const { notices } = input;
  return createPetProactive({
    rules: notices.ruleStore,
    state: input.state,
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
        ...(input.accounting ? { accounting: input.accounting } : {}),
      }),
    log: input.log,
  });
}
