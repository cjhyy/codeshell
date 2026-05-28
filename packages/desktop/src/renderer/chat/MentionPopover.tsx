/**
 * MentionPopover — the picker that opens when the user types `@` in the
 * composer. Shows two sections:
 *
 *   插件 — installed skills filtered by the query after `@`
 *   文件 — fuzzy file search in the active repo
 *
 * The popover is fully controlled by ChatView: ChatView decides when the
 * mention is "open" (caret is inside an @-token) and what the current
 * query is. The popover loads skills once per `open` and re-runs the
 * file search whenever the query changes. Keyboard navigation (↑/↓ to
 * move, Enter to insert, Esc to close) is wired from ChatView via
 * `selected` + the imperative `onMoveSelection` callbacks — the popover
 * exposes its flat item list through `items` so ChatView can drive the
 * cursor without owning render details.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Puzzle, FileText, Search } from "lucide-react";
import type { SkillSummary, FileSearchHit } from "../../preload/types";

export type MentionItem =
  | { kind: "skill"; skill: SkillSummary }
  | { kind: "file"; file: FileSearchHit };

interface Props {
  /** Active repo cwd. When null the popover only shows skills (no files). */
  cwd: string | null;
  /** Query string after the `@` — empty when user has only typed `@`. */
  query: string;
  /** Index into the flat list (skills first, then files). */
  selected: number;
  /** Pick callback — ChatView turns this into a textarea replacement. */
  onPick: (item: MentionItem) => void;
  /** Bubble the flat list back up so ChatView can clamp `selected`. */
  onItemsChange: (items: MentionItem[]) => void;
}

export function MentionPopover({
  cwd,
  query,
  selected,
  onPick,
  onItemsChange,
}: Props) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [files, setFiles] = useState<FileSearchHit[]>([]);

  // Skills list: loaded once per cwd. Stable across keystrokes; we
  // filter renderer-side so the @-prefix typing is instant.
  useEffect(() => {
    let cancelled = false;
    if (!cwd) { setSkills([]); return; }
    void window.codeshell
      .listSkills(cwd)
      .then((s) => { if (!cancelled) setSkills(s); })
      .catch(() => { if (!cancelled) setSkills([]); });
    return () => { cancelled = true; };
  }, [cwd]);

  // File search: re-run whenever query changes, with a small debounce so
  // fast typing doesn't fire a search per character.
  useEffect(() => {
    let cancelled = false;
    if (!cwd) { setFiles([]); return; }
    const handle = setTimeout(() => {
      void window.codeshell
        .searchFiles(cwd, query)
        .then((hits) => { if (!cancelled) setFiles(hits); })
        .catch(() => { if (!cancelled) setFiles([]); });
    }, 60);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [cwd, query]);

  // Filter skills client-side by the query — name + description match.
  // Limit to the first 6 so long lists don't push files off-screen.
  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        )
      : skills;
    return matches.slice(0, 8);
  }, [skills, query]);

  // Files: search service already capped + sorted; show top 12 here.
  const visibleFiles = useMemo(() => files.slice(0, 12), [files]);

  // Build the flat list (used for keyboard cursor + onPick lookups).
  const items: MentionItem[] = useMemo(
    () => [
      ...filteredSkills.map((s) => ({ kind: "skill" as const, skill: s })),
      ...visibleFiles.map((f) => ({ kind: "file" as const, file: f })),
    ],
    [filteredSkills, visibleFiles],
  );

  // Notify parent whenever the flat list changes so the cursor stays in range.
  const lastSentRef = useRef<MentionItem[] | null>(null);
  useEffect(() => {
    // Cheap identity check — if the list is the same reference, skip.
    if (lastSentRef.current === items) return;
    lastSentRef.current = items;
    onItemsChange(items);
  }, [items, onItemsChange]);

  const isEmpty = items.length === 0;

  return (
    <div className="mention-popover" role="listbox" aria-label="@ 引用">
      {filteredSkills.length > 0 && (
        <div className="mention-section">
          <div className="mention-section-label">插件</div>
          <ul className="mention-list">
            {filteredSkills.map((s, idx) => {
              const flatIndex = idx;
              const active = flatIndex === selected;
              return (
                <li
                  key={s.filePath}
                  className={`mention-item${active ? " is-active" : ""}`}
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => {
                    // mousedown (not click) so the textarea keeps focus.
                    e.preventDefault();
                    onPick({ kind: "skill", skill: s });
                  }}
                >
                  <Puzzle size={14} className="mention-item-icon" />
                  <span className="mention-item-name">{s.name}</span>
                  <span className="mention-item-desc">{s.description}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {visibleFiles.length > 0 && (
        <div className="mention-section">
          <div className="mention-section-label">文件</div>
          <ul className="mention-list">
            {visibleFiles.map((f, idx) => {
              const flatIndex = filteredSkills.length + idx;
              const active = flatIndex === selected;
              return (
                <li
                  key={f.path}
                  className={`mention-item${active ? " is-active" : ""}`}
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPick({ kind: "file", file: f });
                  }}
                >
                  <FileText size={14} className="mention-item-icon" />
                  <span className="mention-item-name">{f.name}</span>
                  <span className="mention-item-desc">{f.path}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {isEmpty && (
        <div className="mention-empty">
          <Search size={14} />
          <span>
            {cwd ? "未找到匹配的插件或文件" : "请先选择一个项目"}
          </span>
        </div>
      )}
    </div>
  );
}
