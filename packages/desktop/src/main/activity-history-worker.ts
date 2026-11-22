import { searchSessionTranscripts } from "@cjhyy/code-shell-pet/disclosure";
import { readPetSummaryInput } from "./pet/pet-summary-input.js";
import type { RoomHistoryOperations } from "../shared/room-history.js";
import { isProfileLibraryRead, type ProfileLibraryReads } from "../shared/profile-library.js";
import { readProfileLibrary } from "./hosted-profile-library.js";
import { assertSafeSessionId, RoomHistoryReader } from "@cjhyy/code-shell-server/storage";
import {
  petSegmentTranscript,
  type SegmentClosureInput,
} from "./pet/pet-segment-closure-service.js";
import { createMimiExternalActivity } from "../host/composition/mimi-external-activity.js";
import { externalHistory, externalSessions } from "../host/composition/cc-room-history.js";
import { claimBusinessCommit } from "../host/composition/business-calls.js";
import type { ActivityReads } from "../shared/activity-history-contracts.js";
import { listTitles, setTitle } from "./session-titles-store.js";
import { tailLog } from "./logs-service.js";
import { listRunsForUi, getRunHistory } from "./run-history-service.js";
import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import { createTraceHistoryService } from "./trace-history-service.js";
import { readUsageHistory } from "./usage-history-service.js";
import type {
  ActivityHistoryWorkerOptions,
  ActivityHistoryWorkerReply,
  ActivityHistoryWorkerRequest,
} from "./activity-history-worker-client.js";

const port = parentPort;
if (!port) throw new Error("activity history requires a worker thread");
const options = workerData as ActivityHistoryWorkerOptions;
const store = new ModelTraceStore({ storageDir: join(options.sessionsDir, ".model-traces") });
const history = createTraceHistoryService({ storageDir: store.storageDir, store });
const externalActivity = createMimiExternalActivity(() =>
  port.postMessage({ type: "mimi-external-changed" }),
);
let rooms: RoomHistoryReader | undefined;
let tail = Promise.resolve();
port.on("message", ({ id, method, input, permit }: ActivityHistoryWorkerRequest) => {
  // FIFO includes configuration writes and the shutdown maintenance barrier.
  tail = tail.then(async () => {
    try {
      let value: unknown;
      if (isProfileLibraryRead(method)) value = await readProfileLibrary(method, input as ProfileLibraryReads[typeof method]["params"]);
      else if (method === "activity/searchTranscripts") {
        const { query } = input as ActivityReads["activity/searchTranscripts"]["params"];
        value = await searchSessionTranscripts(options.sessionsDir, query, { budgetMs: 5000 });
      }
      else if (method === "activity/titles") value = await listTitles();
      else if (method === "activity/logTail") {
        const { bucket, lines } = input as ActivityReads["activity/logTail"]["params"];
        value = await tailLog(bucket, lines);
      } else if (method === "activity/usage")
        value = readUsageHistory(
          (input as ActivityReads["activity/usage"]["params"]).query,
          options.sessionsDir,
        );
      else if (method === "mimiSummaryInput") {
        if (typeof input !== "string") throw Error("Invalid summary Session");
        assertSafeSessionId(input);
        value = await readPetSummaryInput(join(options.sessionsDir, input));
      } else if (method === "mimiSegmentWindow" || method === "mimiSegmentMessages") {
        const request = input as {
          petSessionId: string;
          input: SegmentClosureInput;
          range: { start: number; end: number };
        };
        assertSafeSessionId(request.petSessionId);
        if (!request.petSessionId.startsWith("pet-")) throw Error("Invalid Mimi session");
        const transcript = petSegmentTranscript(
          join(options.sessionsDir, request.petSessionId, "transcript.jsonl"),
        );
        value =
          method === "mimiSegmentWindow"
            ? await transcript.prepare(request.input)
            : await transcript.read(request.range);
      } else if (method === "mimiExternalActivity")
        value = await externalActivity.snapshot(
          input as Parameters<typeof externalActivity.snapshot>[0],
        );
      else if (method === "rooms/messages" || method === "rooms/historyPage") {
        if (!options.roomsDir) throw new Error("Room history is unavailable");
        rooms ??= new RoomHistoryReader(options.roomsDir);
        const args = input as RoomHistoryOperations[typeof method]["input"];
        if (rooms.rootIdentity !== args.rootIdentity) throw new Error("Room storage root changed");
        if (method === "rooms/messages") {
          const { roomId, sinceSeq } = args as RoomHistoryOperations["rooms/messages"]["input"];
          value = rooms.getMessages(roomId, sinceSeq);
        } else {
          const { roomId, request } = args as RoomHistoryOperations["rooms/historyPage"]["input"];
          value = rooms.getHistoryPage(roomId, request);
        }
      } else if (method === "externalSessions")
        value = await externalSessions(input as Parameters<typeof externalSessions>[0]);
      else if (method === "externalHistory")
        value = externalHistory(input as Parameters<typeof externalHistory>[0]);
      else if (method === "activity/runs")
        value = await listRunsForUi(input as ActivityReads["activity/runs"]["params"]);
      else if (method === "activity/run")
        value = await getRunHistory((input as { runId: string }).runId);
      else if (method === "activity/setTitle") {
        const { id, title } = input as { id: string; title: string };
        await setTitle(id, title, () => claimBusinessCommit(permit!));
      } else if (method === "list") value = history.list(input);
      else if (method === "sessions") value = history.sessions(input);
      else if (method === "get") value = history.get(input);
      else if (method === "getConfig") value = history.getConfig();
      else if (method === "setConfig")
        value = history.setConfig(input, permit && (() => claimBusinessCommit(permit)));
      else if (method === "flush") {
        externalActivity.close();
        await store.flushMaintenance();
      } else throw new Error("Unknown activity history operation");
      port.postMessage({ id, value } satisfies ActivityHistoryWorkerReply);
    } catch (error) {
      port.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ActivityHistoryWorkerReply);
    }
  });
});
