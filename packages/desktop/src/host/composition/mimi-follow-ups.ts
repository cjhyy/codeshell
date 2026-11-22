import { basename, join } from "node:path";
import { SessionManager, SettingsManager } from "@cjhyy/code-shell-core";
import { assertSafeSessionId } from "@cjhyy/code-shell-server/storage";
import type { ActivityHistoryWorker } from "../../main/activity-history-worker-client.js";
import { resolveNoRepoCwd } from "../../main/no-repo-cwd.js";
import { allowNativePetAuxiliary } from "../../main/pet/pet-native-extraction-policy.js";
import {
  createPetFollowUpService,
  type PetFollowUpInbox,
  type PetFollowUpSession,
} from "../../main/pet/pet-follow-up-service.js";
import { createPetSummaryService } from "../../main/pet/pet-summary-service.js";
import { createPetSummaryStore } from "../../main/pet/pet-summary-store.js";
import type { MimiFollowUpOperations, MimiFollowUpView } from "../../shared/mimi-follow-ups.js";
import type { BusinessGrant, BusinessMethods } from "./business-calls.js";

export function hostedMimiFollowUps(options: {
  petDir: string;
  sessionsDir: string;
  history: Pick<ActivityHistoryWorker, "mimiSummaryInput">;
  sessions(): Promise<readonly PetFollowUpSession[]>;
  managerId(): Promise<string>;
  inbox(grant: BusinessGrant): PetFollowUpInbox;
  generationAllowed?(managerId: string): boolean;
  generate?: (closure: string) => Promise<string>;
}) {
  const store = createPetSummaryStore(join(options.petDir, "summaries.json"));
  let cwd: string | undefined;
  const settingsCwd = () => (cwd ??= resolveNoRepoCwd());
  let summaries: ReturnType<typeof createPetSummaryService> | undefined;
  const summaryService = () =>
    (summaries ??= createPetSummaryService({
      sessionsRootDir: options.sessionsDir,
      cwd: settingsCwd(),
      store,
      readClosureInput: (dir) => options.history.mimiSummaryInput(basename(dir)),
      generate: options.generate,
    }));
  const allowed =
    options.generationAllowed ??
    ((managerId: string) =>
      allowNativePetAuxiliary(
        new SettingsManager(settingsCwd(), "full").getForScope("user"),
        new SessionManager().readSessionState(managerId),
      ));

  async function service(view: MimiFollowUpView, grant: BusinessGrant) {
    grant.assertCurrent();
    const sessions = await options.sessions();
    for (const row of sessions) {
      if (!row.external && row.terminal?.status === "completed")
        assertSafeSessionId(row.agentSessionId);
    }
    const id = await options.managerId();
    grant.assertCurrent();
    const canGenerate = () => {
      if (grant.signal.aborted) return false;
      try {
        return allowed(id);
      } catch {
        return false;
      }
    };
    return createPetFollowUpService({
      listSessions: () => sessions,
      summaryStore: store,
      summaryService: {
        summarize: (session, at) => summaryService().summarize(session, at, canGenerate),
      },
      registered: { load: async () => undefined, list: () => view.registered },
      inbox: options.inbox(grant),
    });
  }
  return {
    methods: {
      async "mimi/followUps"(input, grant) {
        const rows = await (await service(input, grant)).collect(input.options);
        await store.flush();
        return rows;
      },
      async "mimi/openFollowUps"(input, grant) {
        const rows = await (await service(input, grant)).listOpen(input.options);
        await store.flush();
        return rows;
      },
      async "mimi/handleFollowUp"(input, grant) {
        const result = await (await service(input, grant)).mutate(input.mutation);
        await store.flush();
        return result;
      },
    } satisfies Pick<BusinessMethods, keyof MimiFollowUpOperations>,
    close: () => store.flush(),
  };
}
