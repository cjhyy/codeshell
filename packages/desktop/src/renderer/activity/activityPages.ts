import { Activity, ListTodo, MessageSquare, ScrollText, ShieldCheck, Workflow } from "lucide-react";
import type { TranslationKey } from "../i18n/dict";

export type ActivityPage = "traces" | "task_inbox" | "sessions" | "runs" | "approvals" | "logs";

/** One catalog for the activity tabs, settings menu and command palette. */
export const ACTIVITY_PAGES = [
  { page: "traces", label: "observability.title", Icon: Workflow },
  { page: "task_inbox", label: "activity.backgroundWork", Icon: ListTodo },
  { page: "sessions", label: "activity.conversations", Icon: MessageSquare },
  { page: "approvals", label: "auto.approvals.title", Icon: ShieldCheck },
  { page: "logs", label: "activity.diagnostics", Icon: ScrollText },
  { page: "runs", label: "activity.legacyRuns", Icon: Activity },
] as const satisfies ReadonlyArray<{ page: ActivityPage; label: TranslationKey; Icon: unknown }>;

export function isActivityPage(page: string): page is ActivityPage {
  return ACTIVITY_PAGES.some((entry) => entry.page === page);
}
