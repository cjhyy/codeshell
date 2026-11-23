import { sessionsRoot } from "@cjhyy/code-shell-core";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { ActivityHistoryWorker } from "../../main/activity-history-worker-client.js";
import { createPetSegmentClosureService } from "../../main/pet/pet-segment-closure-service.js";
import { nativeExtractionAllowed } from "../../main/pet/pet-native-extraction-policy.js";
import { resolveNoRepoCwd } from "../../main/no-repo-cwd.js";
import type { MimiRecordCall, MimiRecords, MimiRecordDomain } from "../../shared/mimi-records.js";
import type { BusinessGrant, BusinessMethods } from "./business-calls.js";

/** The storage owner provides the local Mimi identity; the document cannot select a transcript path. */
export function hostedMimiSegments(
  storage: Promise<StateStorage>,
  history: ActivityHistoryWorker,
  announce: (domain: MimiRecordDomain) => void,
) {
  async function record<K extends keyof MimiRecords>(
    action: K,
    args: Parameters<MimiRecords[K]>,
    grant?: BusinessGrant,
    autoSessionId?: string,
  ): Promise<ReturnType<MimiRecords[K]>> {
    const db = await storage;
    grant?.assertCurrent();
    const permit = new Int32Array(new SharedArrayBuffer(4));
    const abort = () => Atomics.compareExchange(permit, 0, 0, -1);
    grant?.signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await db.request<{
        result: ReturnType<MimiRecords[K]>;
        changed?: MimiRecordDomain;
      }>("mimi/records", { call: { action, args } as MimiRecordCall, permit, autoSessionId });
      if (!result) throw Error("Mimi storage unavailable");
      if (result.changed) announce(result.changed);
      return result.result;
    } finally {
      grant?.signal.removeEventListener("abort", abort);
    }
  }
  async function service(grant?: BusinessGrant) {
    const { petSessionId } = await record("metadata", [], grant);
    return createPetSegmentClosureService({
      petSessionId,
      sessionsRootDir: sessionsRoot(),
      cwd: resolveNoRepoCwd(),
      autoExtractEnabled: () => !grant?.signal.aborted && nativeExtractionAllowed(petSessionId),
      journal: {
        recordedSegmentIds: async () => new Set(await record("journalIds", [], grant)),
        record: (entry) => record("record", [entry], grant, petSessionId),
      },
      memory: { remember: (...args) => record("remember", args, grant, petSessionId) },
      transcript: {
        prepare: (input) => history.mimiSegmentWindow({ petSessionId, input }),
        read: (range) => history.mimiSegmentMessages({ petSessionId, range }),
      },
    });
  }
  return {
    async "mimi/extractionAllowed"(_, grant) {
      return nativeExtractionAllowed((await record("metadata", [], grant)).petSessionId);
    },
    async "mimi/closeSegment"(input, grant) {
      return (await service(grant)).close(input);
    },
    async "mimi/backfillSegments"({ segments, now }, grant) {
      return (await service(grant)).backfill(segments, now);
    },
    async "mimi/segmentMessages"(range) {
      return (await service()).readSegmentMessages(range);
    },
  } satisfies Pick<
    BusinessMethods,
    | "mimi/extractionAllowed"
    | "mimi/closeSegment"
    | "mimi/backfillSegments"
    | "mimi/segmentMessages"
  >;
}
