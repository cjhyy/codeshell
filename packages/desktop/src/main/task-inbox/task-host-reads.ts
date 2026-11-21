import { join } from "node:path";
import { SettingsManager, userHome } from "@cjhyy/code-shell-core";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { DesktopHostMethod } from "../desktop-host/server.js";
import { createTaskInboxPages } from "./task-inbox-pages.js";
import { checkedTaskObject, checkedTaskText, parseTaskInboxListQuery, type TaskInboxSnapshot, type TaskInboxRecordV1 } from "./task-inbox-types.js";

export function taskInboxEnabled(): boolean {
  const settings = new SettingsManager(join(userHome(), ".code-shell", "no-repo"), "full").getForScope("user");
  return settings.featureFlags?.taskInboxV1 !== false;
}

/** The public port exposes only task reads. Lifecycle and executor commands use the private parent pipe. */
export function taskHostReads(storage: Promise<StateStorage>, enabled = taskInboxEnabled): [string, DesktopHostMethod][] {
  const pages = createTaskInboxPages(async (visibility) => {
    const result = await (await storage).request<TaskInboxSnapshot>("tasks/snapshot", { visibility });
    if (!result) throw new Error("Task storage is unavailable");
    return result;
  });
  const checkEnabled = () => {
    if (!enabled()) throw new Error("Task inbox is disabled");
  };
  return [
    ["tasks/list", {run(ctx, params) {
      checkEnabled();
      return pages.list(ctx.identity, parseTaskInboxListQuery(params), () => { ctx.assertCurrent(); checkEnabled(); });
    }}],
    ["tasks/get", {async run(ctx, params) {
      checkEnabled();
      const input = checkedTaskObject(params, new Set(["taskKey"]));
      const taskKey = checkedTaskText(input.taskKey,"key",1100);
      const result = await (await storage).request<TaskInboxRecordV1>("tasks/get", {taskKey});
      ctx.assertCurrent();
      checkEnabled();
      return result;
    }}],
  ];
}
