import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { Repo } from "../repos";
import { repoLabel } from "../repos";
import { NO_REPO_KEY, type SessionIndex, type SessionSummary } from "../transcripts";

interface Props {
  open: boolean;
  onClose: () => void;
  repos: Repo[];
  sessions: Record<string, SessionIndex>;
  activeRepoId: string | null;
  /** Caller switches to the chosen session. */
  onPick: (repoId: string | null, sessionId: string) => void;
}

interface Hit {
  repoId: string | null;
  repoLabel: string;
  session: SessionSummary;
}

/**
 * Cmd-K style global session search overlay (matches the
 * session-search reference screenshot).
 *
 * - Centered dim-backdropped modal.
 * - Input is focused on open.
 * - Before typing: shows recent sessions across all repos + no-repo.
 * - While typing: substring match on session title + repo label.
 * - Up/Down to navigate, Enter to pick, Esc to close.
 *
 * Search corpus excludes archived sessions — those have their own
 * dedicated path through the per-project '已归档' group.
 */
export function SessionSearchModal({
  open,
  onClose,
  repos,
  sessions,
  activeRepoId,
  onPick,
}: Props) {
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    setCursor(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Flatten all live sessions across all repos into a single ranked list.
  const allHits: Hit[] = useMemo(() => {
    const out: Hit[] = [];
    for (const r of repos) {
      const idx = sessions[r.id];
      if (!idx) continue;
      for (const s of idx.sessions) {
        if (s.archived) continue;
        out.push({ repoId: r.id, repoLabel: repoLabel(r), session: s });
      }
    }
    const noRepoIdx = sessions[NO_REPO_KEY];
    if (noRepoIdx) {
      for (const s of noRepoIdx.sessions) {
        if (s.archived) continue;
        out.push({ repoId: null, repoLabel: "对话", session: s });
      }
    }
    // Default sort: most-recently-updated first.
    out.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    return out;
  }, [repos, sessions]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allHits.slice(0, 20);
    return allHits
      .filter((h) =>
        h.session.title.toLowerCase().includes(q) ||
        h.repoLabel.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [allHits, filter]);

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [cursor, filtered.length]);

  if (!open) return null;

  const pick = (h: Hit): void => {
    onPick(h.repoId, h.session.id);
    onClose();
  };

  return (
    <div className="ssm-backdrop" onMouseDown={onClose}>
      <div className="ssm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ssm-search">
          <Search size={14} />
          <input
            ref={inputRef}
            placeholder="搜索对话"
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
        <div className="ssm-section-label">
          {filter ? "搜索结果" : "近期对话"}
        </div>
        <ul className="ssm-list">
          {filtered.length === 0 && (
            <li className="ssm-empty">没有匹配的对话</li>
          )}
          {filtered.map((h, i) => {
            const isActive =
              activeRepoId === h.repoId &&
              false; // hits not "active" in the picker — only the cursor is.
            void isActive;
            return (
              <li
                key={`${h.repoId ?? "_"}::${h.session.id}`}
                className={`ssm-item${i === cursor ? " cursor" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(h)}
              >
                <span className="ssm-item-title">{h.session.title}</span>
                <span className="ssm-item-meta">
                  <span className="ssm-item-repo">{h.repoLabel}</span>
                  <span className="ssm-item-time">{formatRelative(h.session.updatedAt)}</span>
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
  const delta = Date.now() - ts;
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}月`;
  const year = Math.floor(day / 365);
  return `${year}年`;
}
