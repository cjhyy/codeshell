import {
  PET_NOTICES_QUERY_ACTION,
  PET_NOTIFICATION_SETTINGS_QUERY_ACTION,
  PET_TRIGGERS_QUERY_ACTION,
} from "@cjhyy/code-shell-pet/protocol";
import type { HostActionHandler } from "../host-action-dispatch.js";
import type { PetHostActionExecutor } from "./pet-dispatch-service.js";
import type { PetNoticeControls } from "./pet-notice-ipc.js";
import type { PetNoticeTurnGate } from "./pet-notice-turn-gate.js";
import {
  createMimiNoticeChanges,
  type MimiNoticeChangesDeps,
  type MimiNoticeRuleControls,
} from "./pet-mimi-notice-changes.js";
import { createMimiNoticeReads, type MimiNoticeReadsDeps } from "./pet-mimi-notice-reads.js";

export { ownerTurnRefusal, type MimiNoticeRuleControls } from "./pet-mimi-notice-changes.js";
export type { MimiTurnOrigin, PetRecentProactiveNotice } from "./pet-mimi-notice-reads.js";

/**
 * Mimi's own notice tools, Desktop side (design §4.7): the three read
 * loopbacks registered on the worker bridge (Mimi's Session only), the two
 * deferred change executors for the dispatcher, and her turns' recent
 * briefs. Everything is built from main's existing notice wiring.
 */
export interface MimiNoticeToolsDeps
  extends Omit<MimiNoticeReadsDeps, "rules">, Omit<MimiNoticeChangesDeps, "controls"> {
  bridge: { setHostActionHandler(action: string, handler: HostActionHandler): () => void };
  /** Mimi's own Session: the only caller the read loopbacks answer. */
  isMimiSession(sessionId: string): boolean;
  /**
   * The settings page's rule controls (`createPetNoticeControls`), late-bound:
   * main builds them after the dispatcher that runs these executors.
   */
  controls(): Pick<PetNoticeControls, "getState" | "updateRule"> | undefined;
}

export function wireMimiNoticeTools(deps: MimiNoticeToolsDeps) {
  const ruleControls = (): MimiNoticeRuleControls | undefined => {
    const controls = deps.controls();
    return controls
      ? {
          rules: async () => (await controls.getState()).rules ?? [],
          updateRule: (request) => controls.updateRule(request),
        }
      : undefined;
  };
  const rules = async () => {
    const controls = ruleControls();
    if (!controls) throw new Error("notice rules are not ready yet");
    return controls.rules();
  };
  const reads = createMimiNoticeReads({ ...deps, rules });
  const changes = createMimiNoticeChanges({ ...deps, controls: ruleControls });
  /** Mimi Sessions whose running turn is the owner's (set by the dispatcher per turn). */
  const ownerTurns = new Set<string>();
  const turnGate: PetNoticeTurnGate = {
    isOwnerConversation: (channel, target) => deps.isOwnerConversation(channel, target),
    begin: (sessionId, owner) => {
      if (owner) ownerTurns.add(sessionId);
      else ownerTurns.delete(sessionId);
    },
    end: (sessionId) => ownerTurns.delete(sessionId),
  };
  const onlyMimi =
    (read: (args: Record<string, unknown>) => Promise<unknown>): HostActionHandler =>
    async (sessionId, args) => {
      if (!deps.isMimiSession(sessionId)) throw new Error("only Mimi's Session may read notices");
      // Defence in depth: the tools are hidden outside the owner's turns anyway.
      if (!ownerTurns.has(sessionId))
        throw new Error("notices are readable only in the owner's turn");
      return read(args);
    };
  const removers = [
    deps.bridge.setHostActionHandler(PET_NOTICES_QUERY_ACTION, onlyMimi(reads.noticesQuery)),
    deps.bridge.setHostActionHandler(PET_TRIGGERS_QUERY_ACTION, onlyMimi(reads.triggersQuery)),
    deps.bridge.setHostActionHandler(
      PET_NOTIFICATION_SETTINGS_QUERY_ACTION,
      onlyMimi(reads.settingsQuery),
    ),
  ];
  const hostActions: Record<string, PetHostActionExecutor> = {
    noticeTriggerMutation: changes.noticeTriggerMutation,
    notificationSettingsMutation: changes.notificationSettingsMutation,
  };
  return {
    hostActions,
    recentProactive: reads.recentProactive,
    /** For the dispatcher (`noticeTurns`): whose turn is running. */
    turnGate,
    dispose() {
      ownerTurns.clear();
      for (const remove of removers) remove();
    },
  };
}
