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

  const itemCls = (active: boolean) =>
    "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent " +
    (active ? "bg-accent" : "");

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Folder size={12} />
        <span className="max-w-[160px] truncate">{triggerLabel}</span>
        <ChevronDown size={11} className="opacity-60" />
      </button>

      {open && (
        <div className="absolute bottom-full z-50 mb-1 w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search size={12} className="opacity-50" />
            <input
              ref={inputRef}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder="搜索项目"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button className="opacity-50 hover:opacity-100" onClick={() => setFilter("")} aria-label="清除">
                <X size={12} />
              </button>
            )}
          </div>

          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">没有匹配项目</li>
            )}
            {filtered.map((r) => {
              const isActive = r.id === activeRepoId;
              return (
                <li
                  key={r.id}
                  className={itemCls(isActive)}
                  onClick={() => { onSelect(r.id); setOpen(false); }}
                >
                  <Folder size={12} className="opacity-60" />
                  <span className="flex-1 truncate">{repoLabel(r)}</span>
                  {isActive && <Check size={12} className="text-primary" />}
                </li>
              );
            })}
          </ul>

          <div className="my-1 h-px bg-border" />

          <ul className="py-1">
            <li className={itemCls(false)} onClick={() => { onAddRepo(); setOpen(false); }}>
              <FolderPlus size={12} className="opacity-60" />
              <span className="flex-1 truncate">添加新项目</span>
            </li>
            <li
              className={itemCls(activeRepoId === null)}
              onClick={() => { onSelect(null); setOpen(false); }}
            >
              <Folder size={12} className="opacity-60" />
              <span className="flex-1 truncate">不使用项目</span>
              {activeRepoId === null && <Check size={12} className="text-primary" />}
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
