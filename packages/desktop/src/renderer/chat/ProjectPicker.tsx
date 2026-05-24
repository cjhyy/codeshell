import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Folder, FolderPlus, Search, X, Check } from "lucide-react";
import { repoLabel, type Repo } from "../repos";

interface Props {
  repos: Repo[];
  activeRepoId: string | null;
  onSelect: (id: string | null) => void;
  onAddRepo: () => void;
  disabled?: boolean;
}

/**
 * Composer-row project pill with a dropdown.
 *
 * Renders the active project (or "不使用项目" when null) plus a chevron;
 * click opens a small popover with:
 *   - search field
 *   - existing projects (active one marked with ✓)
 *   - 添加新项目
 *   - 不使用项目
 *
 * Mirrors the project-switcher reference screenshot.
 */
export function ProjectPicker({ repos, activeRepoId, onSelect, onAddRepo, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => repoLabel(r).toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
  }, [repos, filter]);

  const active = repos.find((r) => r.id === activeRepoId) ?? null;
  const triggerLabel = active ? repoLabel(active) : "不使用项目";

  return (
    <div className="project-picker" ref={wrapRef}>
      <button
        type="button"
        className="composer-pill project-picker-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Folder size={12} />
        <span className="project-picker-name">{triggerLabel}</span>
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="project-picker-popover">
          <div className="project-picker-search">
            <Search size={12} />
            <input
              ref={inputRef}
              placeholder="搜索项目"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button className="project-picker-clear" onClick={() => setFilter("")} aria-label="清除">
                <X size={12} />
              </button>
            )}
          </div>

          <ul className="project-picker-list">
            {filtered.length === 0 && (
              <li className="project-picker-empty">没有匹配项目</li>
            )}
            {filtered.map((r) => {
              const isActive = r.id === activeRepoId;
              return (
                <li
                  key={r.id}
                  className={`project-picker-item${isActive ? " active" : ""}`}
                  onClick={() => {
                    onSelect(r.id);
                    setOpen(false);
                  }}
                >
                  <Folder size={12} className="project-picker-item-icon" />
                  <span className="project-picker-item-label">{repoLabel(r)}</span>
                  {isActive && <Check size={12} className="project-picker-item-check" />}
                </li>
              );
            })}
          </ul>

          <div className="project-picker-divider" />

          <ul className="project-picker-list">
            <li
              className="project-picker-item"
              onClick={() => {
                onAddRepo();
                setOpen(false);
              }}
            >
              <FolderPlus size={12} className="project-picker-item-icon" />
              <span className="project-picker-item-label">添加新项目</span>
            </li>
            <li
              className={`project-picker-item${activeRepoId === null ? " active" : ""}`}
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
            >
              <Folder size={12} className="project-picker-item-icon" />
              <span className="project-picker-item-label">不使用项目</span>
              {activeRepoId === null && <Check size={12} className="project-picker-item-check" />}
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
