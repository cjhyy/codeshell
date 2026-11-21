import { SqlTaskReadRows } from "./task-projection-rows.js";
import { displayTask, taskSnapshot } from "./task-projection.js";
import { join } from "node:path";
import { SettingsManager, userHome } from "@cjhyy/code-shell-core";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { DesktopHostMethod } from "../desktop-host/server.js";
import { createTaskInboxPages } from "./task-inbox-pages.js";
import {
  checkedTaskObject,
  checkedTaskText,
  parseTaskInboxListQuery,
  type TaskInboxSnapshot,
  type TaskInboxRecordV1,
} from "./task-inbox-types.js";

export function taskInboxEnabled(): boolean {
  const settings = new SettingsManager(
    join(userHome(), ".code-shell", "no-repo"),
    "full",
  ).getForScope("user");
  return settings.featureFlags?.taskInboxV1 !== false;
}

/** The public port exposes only task reads. Lifecycle and executor commands use the private parent pipe. */
export function taskHostReads(
  storage: Promise<StateStorage>,
  enabled = taskInboxEnabled,
): [string, DesktopHostMethod][] {
  let readiness: Promise<StateStorage> | undefined;
  function ready() {
    return (readiness ??= storage
      .then(async (db) => {
        if (!(await db.request("tasks/ready"))) throw new Error("Task storage is unavailable");
        return db;
      })
      .catch((error) => {
        readiness = undefined;
        throw error;
      }));
  }
  const pages = createTaskInboxPages(async (visibility) => {
    const db = await ready();
    const indexed = db.readSnapshot((view) => taskSnapshot(new SqlTaskReadRows(view), visibility));
    if (indexed) return indexed;
    const result = await db.request<TaskInboxSnapshot>("tasks/snapshot", { visibility });
    if (!result) throw new Error("Task storage is unavailable");
    return result;
  });
  const checkEnabled = () => {
    if (!enabled()) throw new Error("Task inbox is disabled");
  };
  return [
    [
      "tasks/list",
      {
        run(ctx, params) {
          checkEnabled();
          return pages.list(ctx.identity, parseTaskInboxListQuery(params), () => {
            ctx.assertCurrent();
            checkEnabled();
          });
        },
      },
    ],
    [
      "tasks/get",
      {
        async run(ctx, params) {
          checkEnabled();
          const input = checkedTaskObject(params, new Set(["taskKey"]));
          const taskKey = checkedTaskText(input.taskKey, "key", 1100);
          const db = await ready();
          const indexed = db.readSnapshot((view) =>
            new SqlTaskReadRows(view).rows({ key: taskKey }),
          );
          const result = indexed
            ? indexed[0]
              ? displayTask(indexed[0])
              : null
            : await db.request<TaskInboxRecordV1>("tasks/get", { taskKey });
          ctx.assertCurrent();
          checkEnabled();
          return result;
        },
      },
    ],
  ];
}
