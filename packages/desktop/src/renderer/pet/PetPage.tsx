import React from "react";
import { useT } from "../i18n";
import { ChevronDown, PanelRightClose, PanelRightOpen, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PetState } from "./petStateReducer";

export interface PetPageProps {
  children?: React.ReactNode;
  overview?: Pick<PetState, "projection" | "overviewFocus">;
  runningCount?: number;
  pendingCount?: number;
  focusPending?: boolean;
  /** A long task was opened from outside (e.g. a notification); show the work rail. */
  revealTask?: boolean;
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
  revealTask = false,
}: PetPageProps) {
  const { t } = useT();
  React.useEffect(() => {
    const report = window.codeshell?.computerUse?.setCompanionChatActive;
    void report?.(true).catch(() => {});
    return () => {
      void report?.(false).catch(() => {});
    };
  }, []);
  const reveal = focusPending || revealTask;
  const [workExpanded, setWorkExpanded] = React.useState(reveal);
  const [focusMode, setFocusMode] = React.useState(false);
  // Adjust during render, not in an effect: the work rail's own effects scroll
  // and focus the requested item, and child effects run before a parent
  // effect could unhide the rail, so they would target a display:none column.
  const [revealed, setRevealed] = React.useState(reveal);
  if (reveal !== revealed) {
    setRevealed(reveal);
    if (reveal) {
      setWorkExpanded(true);
      setFocusMode(false);
    }
  }
  const [work, ...chat] = React.Children.toArray(children);
  const workId = React.useId();
  return (
    <section
      data-pet-page="standalone"
      aria-label={t("pet.overview.regionLabel")}
      className="mimi-page-shell @container/pet-page relative flex h-full min-w-0 flex-1 flex-col overflow-hidden motion-reduce:**:animate-none motion-reduce:**:transition-none"
    >
      <header className="mimi-page-heading mx-auto flex w-full max-w-[1680px] shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-4 @min-[1100px]/pet-page:px-6 @min-[1100px]/pet-page:pb-4 @min-[1100px]/pet-page:pt-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-primary">
            <Sparkles size={17} aria-hidden="true" />
            <h1 className="text-base font-semibold tracking-tight text-foreground">
              {t("pet.overview.title")}
            </h1>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("pet.overview.workspaceHint")}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-pet-focus-mode="toggle"
          aria-pressed={focusMode}
          aria-controls={workId}
          aria-label={t(focusMode ? "pet.overview.showActivity" : "pet.overview.focusMode")}
          title={t(focusMode ? "pet.overview.showActivity" : "pet.overview.focusMode")}
          className="hidden shrink-0 gap-2 rounded-lg px-3 text-xs font-normal text-muted-foreground @min-[1100px]/pet-page:inline-flex"
          onClick={() => setFocusMode((value) => !value)}
        >
          {focusMode ? (
            <PanelRightOpen size={15} aria-hidden="true" />
          ) : (
            <PanelRightClose size={15} aria-hidden="true" />
          )}
          {t(focusMode ? "pet.overview.showActivity" : "pet.overview.focusMode")}
        </Button>
      </header>
      <div
        data-pet-workspace-layout={focusMode ? "focused" : "split"}
        className={`mx-auto grid min-h-0 w-full max-w-[1680px] flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden px-3 pb-3 @min-[1100px]/pet-page:grid-rows-1 @min-[1100px]/pet-page:overflow-hidden @min-[1100px]/pet-page:px-6 @min-[1100px]/pet-page:pb-5 @min-[1440px]/pet-page:gap-5 ${focusMode ? "@min-[1100px]/pet-page:grid-cols-1" : "@min-[1100px]/pet-page:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]"}`}
      >
        <div
          className={`min-h-0 @min-[1100px]/pet-page:col-start-2 @min-[1100px]/pet-page:row-start-1 @min-[1100px]/pet-page:overflow-hidden ${focusMode ? "@min-[1100px]/pet-page:hidden" : ""}`}
        >
          <button
            type="button"
            data-pet-work-toggle="true"
            aria-expanded={workExpanded}
            aria-controls={workId}
            className="mimi-work-toggle flex min-h-11 w-full items-center gap-2 rounded-xl border border-border/60 bg-card px-3 py-2.5 text-left text-xs @min-[1100px]/pet-page:hidden"
            onClick={() => setWorkExpanded((value) => !value)}
          >
            <span
              className={`min-w-0 flex-1 ${pendingCount > 0 ? "font-medium text-status-warn" : "text-muted-foreground"}`}
            >
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
            className={`${workExpanded ? "mt-2 max-h-[min(30svh,max(80px,calc(100svh_-_450px)))] overflow-y-auto" : "hidden"} @min-[1100px]/pet-page:mt-0 @min-[1100px]/pet-page:block @min-[1100px]/pet-page:h-full @min-[1100px]/pet-page:max-h-full @min-[1100px]/pet-page:overflow-y-auto`}
          >
            {work}
          </div>
        </div>
        {chat}
      </div>
    </section>
  );
}
