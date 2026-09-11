import React from "react";
import { useT } from "../i18n";
import { ChevronDown } from "lucide-react";
import type { PetState } from "./petStateReducer";

export interface PetPageProps {
  children?: React.ReactNode;
  overview?: Pick<PetState, "projection" | "overviewFocus">;
  runningCount?: number;
  pendingCount?: number;
  focusPending?: boolean;
}

/**
 * A first-class application page. Navigation owns whether this tree exists;
 * unlike the former overview overlay it never hides an already-mounted chat
 * surface underneath itself.
 */
export function PetPage({
  children,
  overview,
  runningCount = overview?.projection?.sessions.filter(
    (session) => session.runState === "running" || session.runState === "queued",
  ).length ?? 0,
  pendingCount = overview?.projection?.pending.length ?? 0,
  focusPending = overview?.overviewFocus === "pending",
}: PetPageProps) {
  const { t } = useT();
  const [workExpanded, setWorkExpanded] = React.useState(focusPending);
  React.useEffect(() => {
    if (focusPending) setWorkExpanded(true);
  }, [focusPending]);
  const [work, ...chat] = React.Children.toArray(children);
  const workId = React.useId();
  return (
    <section
      data-pet-page="standalone"
      aria-label={t("pet.overview.regionLabel")}
      className="mimi-page-shell @container/pet-page relative flex h-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      <h1 className="sr-only">{t("pet.overview.title")}</h1>
      <div className="mx-auto grid min-h-0 w-full max-w-[1680px] flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden p-4 @min-[1100px]/pet-page:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] @min-[1100px]/pet-page:grid-rows-1 @min-[1100px]/pet-page:overflow-hidden @min-[1440px]/pet-page:gap-5 @min-[1440px]/pet-page:p-5">
        <div className="min-h-0 @min-[1100px]/pet-page:col-start-2 @min-[1100px]/pet-page:row-start-1 @min-[1100px]/pet-page:overflow-hidden">
          <button
            type="button"
            data-pet-work-toggle="true"
            aria-expanded={workExpanded}
            aria-controls={workId}
            className="flex w-full items-center gap-2 rounded-2xl border border-border/60 bg-background px-4 py-3 text-left text-xs @min-[1100px]/pet-page:hidden"
            onClick={() => setWorkExpanded((value) => !value)}
          >
            <span className="flex-1">
              {t("pet.chat.workSummary", { running: runningCount, pending: pendingCount })}
            </span>
            <span>{t(workExpanded ? "pet.chat.hideWork" : "pet.chat.showWork")}</span>
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={workExpanded ? "rotate-180" : ""}
            />
          </button>
          <div
            id={workId}
            className={`${workExpanded ? "mt-2 max-h-[30dvh] overflow-y-auto" : "hidden"} @min-[1100px]/pet-page:mt-0 @min-[1100px]/pet-page:block @min-[1100px]/pet-page:h-full @min-[1100px]/pet-page:max-h-full @min-[1100px]/pet-page:overflow-y-auto`}
          >
            {work}
          </div>
        </div>
        {chat}
      </div>
    </section>
  );
}
