import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { TrackedProject } from "../projects";
import { projectLabel } from "../projects";
import { NO_REPO_KEY, type SessionIndex, type SessionSummary } from "../transcripts";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";

interface Props {
  open: boolean;
  onClose: () => void;
  projects: TrackedProject[];
  sessions: Record<string, SessionIndex>;
  activeProjectId: string | null;
  /** Caller switches to the chosen session. */
  onPick: (projectId: string | null, sessionId: string) => void;
}

interface Hit {
  projectId: string | null;
  projectLabel: string;
  session: SessionSummary;
}

/**
 * Cmd-K style global session search overlay (matches the
 * session-search reference screenshot).
 *
 * - Centered dim-backdropped modal.
 * - Input is focused on open.
 * - Before typing: shows recent sessions across all projects + no-repo.
 * - While typing: substring match on session title + repo label.
 * - Up/Down to navigate, Enter to pick, Esc to close.
 *
 * Search corpus excludes archived sessions — those have their own
 * dedicated path through the per-project '已归档' group.
 */
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
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    setCursor(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Flatten all live sessions across all projects into a single ranked list.
  const allHits: Hit[] = useMemo(() => {
    const out: Hit[] = [];
    for (const r of projects) {
      const idx = sessions[r.id];
      if (!idx) continue;
      for (const s of idx.sessions) {
        if (s.archived) continue;
        out.push({ projectId: r.id, projectLabel: projectLabel(r), session: s });
      }
    }
    const noRepoIdx = sessions[NO_REPO_KEY];
    if (noRepoIdx) {
      for (const s of noRepoIdx.sessions) {
        if (s.archived) continue;
        out.push({ projectId: null, projectLabel: t("panels.search.noRepoLabel"), session: s });
      }
    }
    // Default sort: most-recently-updated first.
    out.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    return out;
  }, [projects, sessions, t]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allHits.slice(0, 20);
    return allHits
      .filter(
        (h) =>
          h.session.title.toLowerCase().includes(q) || h.projectLabel.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [allHits, filter]);

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [cursor, filtered.length]);

  if (!open) return null;

  const pick = (h: Hit): void => {
    onPick(h.projectId, h.session.id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 px-4 pt-[14vh]"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search size={14} className="text-muted-foreground" />
          <Input
            ref={inputRef}
            className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            placeholder={t("panels.search.placeholder")}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const h = filtered[cursor];
                if (h) pick(h);
              }
            }}
          />
        </div>
        <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {filter ? t("panels.search.results") : t("panels.search.recent")}
        </div>
        <ul className="max-h-[55vh] overflow-y-auto px-2 pb-2">
          {filtered.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("panels.search.noMatch")}
            </li>
          )}
          {filtered.map((h, i) => {
            const isActive = activeProjectId === h.projectId && false; // hits not "active" in the picker — only the cursor is.
            void isActive;
            return (
              <li
                key={`${h.projectId ?? "_"}::${h.session.id}`}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 text-sm",
                  i === cursor ? "bg-accent text-accent-foreground" : "hover:bg-accent/70",
                )}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(h)}
              >
                <span className="min-w-0 truncate font-medium">{h.session.title}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="max-w-32 truncate">{h.projectLabel}</span>
                  <span className="tabular-nums">{formatRelative(h.session.updatedAt)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function formatRelative(ts: number): string {
  // Module-level helper (no hook): translate against the stored language.
  const lang = loadUILanguage();
  const delta = Date.now() - ts;
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return translate(lang, "panels.search.sec", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return translate(lang, "panels.search.min", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return translate(lang, "panels.search.hour", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return translate(lang, "panels.search.day", { n: day });
  const month = Math.floor(day / 30);
  if (month < 12) return translate(lang, "panels.search.month", { n: month });
  const year = Math.floor(day / 365);
  return translate(lang, "panels.search.year", { n: year });
}
