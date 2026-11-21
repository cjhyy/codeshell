import type { UsageQuery } from "@cjhyy/code-shell-core";
import type { ActivityReads, ActivityOperations } from "../../shared/activity-history-contracts.js";
import type { BusinessMethods } from "./business-calls.js";
import { ActivityHistoryWorker } from "../../main/activity-history-worker-client.js";
import {
  businessArguments,
  businessRead,
  noBusinessArguments,
  textArgument,
} from "../../main/desktop-host/business-read.js";
import { assertDesktopSessionId } from "../../main/session-validation.js";

function logQuery(input: unknown): ActivityReads["activity/logTail"]["params"] {
  const { bucket, lines } = businessArguments(input, ["bucket", "lines"]);
  if (bucket !== "ui-ink" && bucket !== "engine" && bucket !== "desktop")
    throw new Error("invalid bucket");
  return {
    bucket,
    lines:
      typeof lines === "number" && Number.isSafeInteger(lines) && lines > 0
        ? Math.min(10_000, lines)
        : undefined,
  };
}
function usageQuery(input: unknown) {
  const { query } = businessArguments(input, ["query"]);
  if (query === undefined) return {};
  const data = businessArguments(query, [
    "runId",
    "scope",
    "sessionId",
    "includeChildren",
    "since",
    "until",
    "limit",
    "cursor",
    "bucketMs",
    "bucketOffsetMs",
  ]);
  for (const k of ["runId", "sessionId", "cursor"])
    if (data[k] !== undefined && typeof data[k] !== "string")
      throw new Error("invalid usage query");
  if (data.scope !== undefined && !["runtime", "session", "store"].includes(data.scope as string))
    throw new Error("invalid usage scope");
  if (data.includeChildren !== undefined && typeof data.includeChildren !== "boolean")
    throw new Error("invalid usage filter");
  for (const k of ["since", "until", "limit", "bucketMs", "bucketOffsetMs"])
    if (data[k] !== undefined && !Number.isSafeInteger(data[k]))
      throw new Error("invalid usage range");
  return { query: data as UsageQuery };
}
function runList(input: unknown) {
  const { includeSessions } = businessArguments(input, ["includeSessions"]);
  if (includeSessions !== undefined && typeof includeSessions !== "boolean")
    throw new Error("invalid run filter");
  return { includeSessions };
}
const runId = (input: unknown) => ({
  runId: textArgument(businessArguments(input, ["runId"]).runId),
});
export function hostedActivityHistory(worker: ActivityHistoryWorker) {
  function view<K extends keyof ActivityReads>(
    method: K,
    parse: (args: unknown) => ActivityReads[K]["params"],
  ) {
    const run = (args: unknown) => worker.view(method, parse(args));
    return { run, port: businessRead(method, parse, (args) => worker.view(method, args)) };
  }
  const titles = view("activity/titles", noBusinessArguments);
  const logs = view("activity/logTail", logQuery);
  const usage = view("activity/usage", usageQuery);
  const runs = view("activity/runs", runList);
  const run = view("activity/run", runId);
  return {
    reads: [titles.port, logs.port, usage.port, runs.port, run.port],
    operations: {
      "activity/titles": titles.run,
      "activity/logTail": logs.run,
      "activity/usage": usage.run,
      "activity/runs": runs.run,
      "activity/run": run.run,
      "activity/setTitle": ({ id, title }, grant) => {
        assertDesktopSessionId(id);
        if (typeof title !== "string" || title.length > 1024 || title.includes("\0"))
          throw new Error("title must be a bounded string");
        return worker.setTitle({ id, title }, grant.permit);
      },
      "trace/list": (query) => worker.list(query),
      "trace/sessions": (query) => worker.sessions(query),
      "trace/get": (id) => worker.get(id),
      "trace/config": () => worker.getConfig(),
      "trace/setConfig": (patch, grant) => worker.setConfig(patch, grant.permit),
    } satisfies Pick<BusinessMethods, keyof ActivityOperations>,
  };
}
