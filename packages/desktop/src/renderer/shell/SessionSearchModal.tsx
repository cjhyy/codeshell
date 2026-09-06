import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, FileSearch, LoaderCircle, MessageSquare, Search } from "lucide-react";
import type { TrackedProject } from "../projects";
import { projectLabel } from "../projects";
import { NO_REPO_KEY, type SessionIndex, type SessionSummary } from "../transcripts";
import type { SessionContentSearchMatch } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useT } from "../i18n/I18nProvider";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";
import { parseContentQuery, resolveContentMatch } from "./sessionContentSearch";
import { SearchDialog } from "./SearchDialog";
import { useSessionContentSearch } from "./useSessionContentSearch";

interface Props {
  open: boolean;
  onClose: () => void;
  projects: TrackedProject[];
  sessions: Record<string, SessionIndex>;
  activeProjectId: string | null;
  onPick: (projectId: string | null, sessionId: string) => void;
}

interface Hit {
  projectId: string | null;
  projectLabel: string;
  session: SessionSummary;
}

/** Global session picker. The legacy `>` prefix still switches to content search. */
export function SessionSearchModal({
  open,
  onClose,
  projects,
  sessions,
  activeProjectId,
  onPick,
}: Props) {
  const { t } = useT();
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { contentMode, term: contentTerm, ready } = parseContentQuery(filter);
  const query = contentMode ? contentTerm : filter;
  const { result, loading, failed, retry } = useSessionContentSearch(
    open && contentMode && ready,
    contentTerm,
  );

  useEffect(() => {
    if (open) setFilter("");
  }, [open]);

  const allHits = useMemo(() => {
    const hits: Hit[] = [];
    for (const project of projects) {
      for (const session of sessions[project.id]?.sessions ?? []) {
        if (!session.archived) {
          hits.push({ projectId: project.id, projectLabel: projectLabel(project), session });
        }
      }
    }
    for (const session of sessions[NO_REPO_KEY]?.sessions ?? []) {
      if (!session.archived) {
        hits.push({ projectId: null, projectLabel: t("panels.search.noRepoLabel"), session });
      }
    }
    return hits.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  }, [projects, sessions, t]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return allHits.slice(0, 20);
    return allHits
      .filter(
        (hit) =>
          hit.session.title.toLowerCase().includes(needle) ||
          hit.projectLabel.toLowerCase().includes(needle),
      )
      .slice(0, 50);
  }, [allHits, filter]);

  const pick = (projectId: string | null, sessionId: string) => {
    onPick(projectId, sessionId);
    onClose();
  };
  const pickContent = (match: SessionContentSearchMatch) => {
    const resolved = resolveContentMatch(match, projects, sessions);
    if (resolved) pick(resolved.projectId, resolved.sessionId);
  };
  const setContentMode = (enabled: boolean) => {
    setFilter(enabled ? `> ${query}` : query);
    inputRef.current?.focus();
  };
  const header = t(contentMode || filter.trim() ? "panels.search.results" : "panels.search.recent");
  const matches = result?.matches ?? [];

  return (
    <SearchDialog
      open={open}
      onClose={onClose}
      title={t("panels.search.placeholder")}
      inputRef={inputRef}
    >
      <div
        className="flex shrink-0 gap-1 px-4 pb-2"
        role="group"
        aria-label={t("panels.search.mode")}
      >
        {[
          { enabled: false, label: t("panels.search.titleMode"), Icon: MessageSquare },
          { enabled: true, label: t("panels.search.contentMode"), Icon: FileSearch },
        ].map(({ enabled, label, Icon }) => (
          <Button
            key={label}
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary"
            aria-pressed={contentMode === enabled}
            onClick={() => setContentMode(enabled)}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </Button>
        ))}
      </div>
      <Command
        label={t("panels.search.placeholder")}
        shouldFilter={false}
        vimBindings={false}
        className="min-h-0 rounded-none bg-transparent"
      >
        <CommandInput
          ref={inputRef}
          className="h-12 text-sm"
          placeholder={t(
            contentMode ? "panels.search.contentPlaceholder" : "panels.search.placeholder",
          )}
          value={query}
          onValueChange={(value) => setFilter(contentMode ? `> ${value}` : value)}
        />
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">
          <span>{header}</span>
          {!loading && (
            <span className="tabular-nums">{contentMode ? matches.length : filtered.length}</span>
          )}
        </div>
        <CommandList label={header} aria-busy={loading} className="min-h-0 max-h-[55vh] px-2 pb-2">
          {contentMode ? (
            !ready ? (
              <SearchState
                icon={<FileSearch className="size-6" />}
                text={t("panels.search.contentHint")}
              />
            ) : loading ? (
              <SearchState
                icon={<LoaderCircle className="size-6 animate-spin motion-reduce:animate-none" />}
                text={t("panels.search.contentLoading")}
              />
            ) : failed ? (
              <SearchState
                icon={<Search className="size-6" />}
                text={t("panels.search.contentFailed")}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1 h-8 rounded-lg"
                  onClick={retry}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  {t("panels.common.retry")}
                </Button>
              </SearchState>
            ) : (
              <>
                {result?.truncated && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    {t("panels.search.contentTruncated")}
                  </p>
                )}
                {matches.length === 0 && (
                  <SearchState
                    icon={<FileSearch className="size-6" />}
                    text={t("panels.search.contentNoMatch")}
                  />
                )}
                {matches.map((match) => {
                  const available = resolveContentMatch(match, projects, sessions) !== null;
                  const snippet = match.snippets[0]?.text;
                  return (
                    <CommandItem
                      key={match.sessionId}
                      value={match.sessionId}
                      disabled={!available}
                      onSelect={() => pickContent(match)}
                      className="min-w-0 flex-col items-start gap-1 rounded-lg px-3 py-2.5"
                    >
                      <span className="w-full truncate text-sm font-medium">{match.title}</span>
                      {snippet && (
                        <span className="line-clamp-2 w-full break-words text-xs leading-5 text-muted-foreground">
                          {snippet}
                        </span>
                      )}
                      {!available && (
                        <span className="text-[11px] text-muted-foreground">
                          {t("panels.search.unavailable")}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </>
            )
          ) : filtered.length === 0 ? (
            <SearchState
              icon={<MessageSquare className="size-6" />}
              text={t(filter.trim() ? "panels.search.noMatch" : "panels.search.noRecent")}
            />
          ) : (
            filtered.map((hit) => (
              <CommandItem
                key={`${hit.projectId ?? "_"}::${hit.session.id}`}
                value={`${hit.projectId ?? "_"}::${hit.session.id}`}
                onSelect={() => pick(hit.projectId, hit.session.id)}
                className="min-w-0 gap-3 rounded-lg px-3 py-2.5"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/60 text-muted-foreground">
                  <MessageSquare className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{hit.session.title}</div>
                  <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="min-w-0 truncate">{hit.projectLabel}</span>
                    {hit.projectId !== null && hit.projectId === activeProjectId && (
                      <span className="shrink-0 text-primary">
                        {t("panels.search.currentProject")}
                      </span>
                    )}
                    <span className="shrink-0 tabular-nums">
                      {formatRelative(hit.session.updatedAt)}
                    </span>
                  </div>
                </div>
                <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </CommandItem>
            ))
          )}
        </CommandList>
      </Command>
    </SearchDialog>
  );
}

function SearchState({
  icon,
  text,
  children,
}: {
  icon: React.ReactNode;
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-3 px-4 py-9 text-center text-sm text-muted-foreground"
    >
      <span className="opacity-60" aria-hidden>
        {icon}
      </span>
      <p>{text}</p>
      {children}
    </div>
  );
}

function formatRelative(ts: number): string {
  const lang = loadUILanguage();
  const sec = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (sec < 60) return translate(lang, "panels.search.sec", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return translate(lang, "panels.search.min", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return translate(lang, "panels.search.hour", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return translate(lang, "panels.search.day", { n: day });
  const month = Math.floor(day / 30);
  if (month < 12) return translate(lang, "panels.search.month", { n: month });
  return translate(lang, "panels.search.year", { n: Math.floor(day / 365) });
}
