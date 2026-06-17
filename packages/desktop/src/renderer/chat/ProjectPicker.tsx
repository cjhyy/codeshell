import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Folder, FolderPlus, Search, X, Check } from "lucide-react";
import { repoLabel, type Repo } from "../repos";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";

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
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverStyle = useAnchoredPopover(open, anchorRef, popoverRef, {
    align: "start",
    preferredSide: "top",
  });

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
  const triggerLabel = active ? repoLabel(active) : t("chat.project.none");

  const itemCls = (active: boolean) =>
    "cs-menu-item flex cursor-pointer gap-2 px-2 py-1.5 text-sm " +
    (active ? "bg-accent" : "");

  return (
    <div className="relative" ref={wrapRef}>
      <Button
        ref={anchorRef}
        type="button"
        variant="outline"
        size="sm"
        className="cs-control h-8 gap-1.5 px-2 py-1 text-xs text-foreground disabled:opacity-50"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Folder size={12} />
        <span className="max-w-[160px] truncate">{triggerLabel}</span>
        <ChevronDown size={11} className="opacity-60" />
      </Button>

      {open && (
        <div
          ref={popoverRef}
          style={popoverStyle}
          className="cs-popup-surface w-64 rounded-md p-1"
        >
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search size={12} className="opacity-50" />
            <Input
              ref={inputRef}
              className="h-7 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
              placeholder={t("chat.project.searchPlaceholder")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <Button variant="ghost" size="icon" className="h-6 w-6 opacity-50 hover:opacity-100" onClick={() => setFilter("")} aria-label={t("chat.project.clearAria")}>
                <X size={12} />
              </Button>
            )}
          </div>

          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">{t("chat.project.noMatch")}</li>
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
              <span className="flex-1 truncate">{t("chat.project.addNew")}</span>
            </li>
            <li
              className={itemCls(activeRepoId === null)}
              onClick={() => { onSelect(null); setOpen(false); }}
            >
              <Folder size={12} className="opacity-60" />
              <span className="flex-1 truncate">{t("chat.project.none")}</span>
              {activeRepoId === null && <Check size={12} className="text-primary" />}
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
