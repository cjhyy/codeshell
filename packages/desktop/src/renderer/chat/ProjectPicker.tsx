import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Folder, FolderPlus, Search, X, Check } from "lucide-react";
import { projectLabel, type TrackedProject } from "../projects";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";

interface Props {
  projects: TrackedProject[];
  activeProjectId: string | null;
  onSelect: (id: string | null) => void;
  onAddProject: () => void;
  disabled?: boolean;
}

/**
 * Composer-row project pill with a dropdown.
 *
 * Renders the active project (or "不使用项目" when null) plus a chevron;
 * click opens a small popover with:
 *   - search field
 *   - existing projects (active one marked with ✓)
 *   - 添加已有项目目录
 *   - 不使用项目
 *
 * Mirrors the project-switcher reference screenshot.
 */
export function ProjectPicker({
  projects,
  activeProjectId,
  onSelect,
  onAddProject,
  disabled,
}: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [focusedProject, setFocusedProject] = useState<string | null>(null);
  const popupId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const noneRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const opening = useRef(false);
  const composing = useRef(false);
  const focusedOption = useRef<HTMLButtonElement | null>(null);
  const focusGeometry = useRef<{
    target: HTMLElement;
    bounds: string;
    projects: TrackedProject[];
  } | null>(null);
  const isOpen = open && !disabled;
  const popoverStyle = useAnchoredPopover(isOpen, anchorRef, popoverRef, {
    align: "start",
    preferredSide: "top",
  });

  useLayoutEffect(() => {
    if (disabled) {
      opening.current = false;
      setOpen(false);
    }
  }, [disabled]);

  useLayoutEffect(() => {
    if (!isOpen) {
      composing.current = false;
      return;
    }
    const onOutside = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      opening.current = false;
      setOpen(false);
    };
    const onBlur = () => {
      opening.current = false;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("focusin", onOutside, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("focusin", onOutside, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [isOpen]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (project) =>
        projectLabel(project).toLowerCase().includes(q) || project.path.toLowerCase().includes(q),
    );
  }, [projects, filter]);

  const revealOption = useCallback(
    (keyboard = false) => {
      const list = listRef.current;
      const focused = document.activeElement;
      if (!list || !(focused instanceof HTMLElement) || !list.contains(focused)) {
        focusGeometry.current = null;
        return;
      }
      const bounds = list.getBoundingClientRect();
      const geometry = `${bounds.left},${bounds.top},${list.clientWidth},${list.clientHeight}`;
      const previous = focusGeometry.current;
      // Anchoring also updates after scroll events. Keep intentional user Wheel
      // scrolling; reveal the focused row only after navigation or layout changes.
      if (
        !keyboard &&
        previous?.target === focused &&
        previous.bounds === geometry &&
        previous.projects === filtered
      )
        return;
      focusGeometry.current = { target: focused, bounds: geometry, projects: filtered };
      const box = focused.getBoundingClientRect();
      const top = bounds.top + list.clientTop;
      const bottom = top + list.clientHeight;
      if (box.top < top - 1) list.scrollTop += box.top - top;
      else if (box.bottom > bottom + 1) list.scrollTop += box.bottom - bottom;
    },
    [filtered],
  );

  useLayoutEffect(() => {
    if (!isOpen || popoverStyle.visibility !== "visible") return;
    const active = document.activeElement;
    if (opening.current) {
      opening.current = false;
      if (active === anchorRef.current) inputRef.current?.focus({ preventScroll: true });
    } else if (
      focusedOption.current &&
      !focusedOption.current.isConnected &&
      active === document.body
    ) {
      inputRef.current?.focus({ preventScroll: true });
      focusedOption.current = null;
    }
    revealOption();
  }, [focusedProject, isOpen, popoverStyle, revealOption]);

  const openMenu = () => {
    if (disabled) return;
    anchorRef.current?.focus({ preventScroll: true });
    opening.current = true;
    composing.current = false;
    focusedOption.current = null;
    setFocusedProject(filtered.find((project) => project.id === activeProjectId)?.id ?? null);
    setOpen(true);
  };
  const closeMenu = (restore = false) => {
    const active = document.activeElement;
    const owned = popoverRef.current?.contains(active) || active === anchorRef.current;
    opening.current = false;
    focusedOption.current = null;
    setOpen(false);
    if (restore && owned && anchorRef.current?.isConnected && !anchorRef.current.disabled)
      anchorRef.current.focus({ preventScroll: true });
  };
  const isComposing = (event: React.KeyboardEvent) =>
    composing.current || event.nativeEvent.isComposing || event.keyCode === 229;
  const focusProject = (index: number) => {
    const project = filtered[Math.max(0, Math.min(index, filtered.length - 1))];
    if (!project) return;
    setFocusedProject(project.id);
    optionRefs.current.get(project.id)?.focus({ preventScroll: true });
    revealOption(true);
  };
  const onPopupKeyDown = (event: React.KeyboardEvent) => {
    if (isComposing(event)) {
      if (event.target !== inputRef.current) event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "Tab" && event.shiftKey && event.target === inputRef.current) {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab" && !event.shiftKey && event.target === noneRef.current) {
      // Continue in the composer's DOM order rather than from the body portal.
      closeMenu(true);
    } else if (
      event.target !== inputRef.current &&
      listRef.current?.contains(event.target as Node)
    ) {
      const index = filtered.findIndex((project) => project.id === focusedProject);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "ArrowUp" && index <= 0) inputRef.current?.focus();
        else
          focusProject(
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? filtered.length - 1
                : index + (event.key === "ArrowDown" ? 1 : -1),
          );
      }
    }
  };

  const active = projects.find((project) => project.id === activeProjectId) ?? null;
  const triggerLabel = active ? projectLabel(active) : t("chat.project.none");
  const tabProject =
    filtered.find((project) => project.id === focusedProject)?.id ?? filtered[0]?.id;

  const itemCls = (active: boolean) =>
    "cs-menu-item flex cursor-pointer gap-2 px-2 py-1.5 text-sm " + (active ? "bg-accent" : "");

  return (
    <div className="relative" ref={wrapRef}>
      <Button
        ref={anchorRef}
        type="button"
        variant="outline"
        size="sm"
        className="cs-control h-8 gap-1.5 px-2 py-1 text-xs text-foreground disabled:opacity-50"
        disabled={disabled}
        aria-haspopup="dialog"
        data-project-picker-trigger=""
        aria-expanded={isOpen}
        aria-controls={isOpen ? popupId : undefined}
        aria-label={triggerLabel}
        title={triggerLabel}
        onKeyDown={(event) => {
          if (isComposing(event)) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu();
          } else if (event.key === "Escape" && isOpen) {
            event.preventDefault();
            closeMenu(true);
          }
        }}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
      >
        <Folder size={12} />
        <span className="max-w-[160px] truncate">{triggerLabel}</span>
        <ChevronDown size={11} className="opacity-60" />
      </Button>

      {isOpen &&
        createPortal(
          <div
            ref={popoverRef}
            id={popupId}
            role="dialog"
            aria-label={t("chat.project.searchPlaceholder")}
            onKeyDown={onPopupKeyDown}
            style={{ ...popoverStyle, overflowY: "hidden" }}
            className="cs-popup-surface flex min-h-0 w-64 flex-col rounded-md p-1"
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
              <Search size={12} className="opacity-50" />
              <Input
                ref={inputRef}
                className="h-7 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                placeholder={t("chat.project.searchPlaceholder")}
                aria-label={t("chat.project.searchPlaceholder")}
                aria-controls={listId}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                onKeyDown={(event) => {
                  if (isComposing(event)) return;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    focusProject(event.key === "ArrowDown" ? 0 : filtered.length - 1);
                  }
                }}
              />
              {filter && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-50 hover:opacity-100"
                  onClick={() => {
                    inputRef.current?.focus();
                    setFilter("");
                  }}
                  aria-label={t("chat.project.clearAria")}
                >
                  <X size={12} />
                </Button>
              )}
            </div>

            <ul
              ref={listRef}
              id={listId}
              className="min-h-0 max-h-64 overflow-y-auto py-1"
              role="listbox"
              aria-label={t("chat.project.searchPlaceholder")}
            >
              {filtered.length === 0 && (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">
                  {t("chat.project.noMatch")}
                </li>
              )}
              {filtered.map((project) => {
                const isActive = project.id === activeProjectId;
                return (
                  <li key={project.id} role="none">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      role="option"
                      aria-selected={isActive}
                      tabIndex={project.id === tabProject ? 0 : -1}
                      ref={(node) => {
                        if (node) optionRefs.current.set(project.id, node);
                        else optionRefs.current.delete(project.id);
                      }}
                      onFocus={(event) => {
                        focusedOption.current = event.currentTarget;
                        setFocusedProject(project.id);
                        revealOption(true);
                      }}
                      className={`${itemCls(isActive)} h-auto w-full justify-start font-normal`}
                      onClick={() => {
                        if (disabled) return;
                        closeMenu(true);
                        onSelect(project.id);
                        setFilter("");
                      }}
                    >
                      <Folder size={12} className="opacity-60" />
                      <span className="flex-1 truncate text-left">{projectLabel(project)}</span>
                      {isActive && <Check size={12} className="text-primary" />}
                    </Button>
                  </li>
                );
              })}
            </ul>

            <div className="my-1 h-px shrink-0 bg-border" />

            <ul className="shrink-0 py-1" role="none">
              <li role="none">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`${itemCls(false)} h-auto w-full justify-start font-normal`}
                  onClick={() => {
                    if (disabled) return;
                    closeMenu(true);
                    onAddProject();
                    setFilter("");
                  }}
                >
                  <FolderPlus size={12} className="opacity-60" />
                  <span className="flex-1 truncate text-left">{t("chat.project.addNew")}</span>
                </Button>
              </li>
              <li role="none">
                <Button
                  ref={noneRef}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={activeProjectId === null}
                  className={`${itemCls(activeProjectId === null)} h-auto w-full justify-start font-normal`}
                  onClick={() => {
                    if (disabled) return;
                    closeMenu(true);
                    onSelect(null);
                    setFilter("");
                  }}
                >
                  <Folder size={12} className="opacity-60" />
                  <span className="flex-1 truncate text-left">{t("chat.project.none")}</span>
                  {activeProjectId === null && <Check size={12} className="text-primary" />}
                </Button>
              </li>
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}
