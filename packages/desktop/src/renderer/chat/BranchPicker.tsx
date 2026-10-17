import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, GitBranch } from "lucide-react";
import type { GitBranches } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { useT } from "../i18n/I18nProvider";

interface Props {
  projectId: string | null;
  cwd: string | null;
  clean?: boolean | null;
  disabled?: boolean;
}

type LoadState = "idle" | "loading" | "ready" | "unavailable" | "error";

function notifyGitBranchesChanged(cwd: string): void {
  window.dispatchEvent(new CustomEvent("codeshell:git-branches-changed", { detail: { cwd } }));
}

export function BranchPicker({ projectId, cwd, clean, disabled }: Props) {
  const { t } = useT();
  const targetRef = useRef({ projectId, cwd });
  if (targetRef.current.projectId !== projectId || targetRef.current.cwd !== cwd) {
    targetRef.current = { projectId, cwd };
  }
  const target = targetRef.current;
  const [resolvedTarget, setResolvedTarget] = useState<typeof target | null>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>("idle");
  const [branches, setBranches] = useState<GitBranches>({
    isRepo: false,
    current: null,
    branches: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [focusedBranch, setFocusedBranch] = useState<string | null>(null);
  const popupId = useId();
  const operationRef = useRef<object | null>(null);
  const popupOwned = useRef(false);
  const restorePending = useRef(false);
  const focusedLayout = useRef("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stashRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const isOpen = open && !disabled && resolvedTarget === target;
  const busy = state === "loading";
  // Anchored to the viewport with flip + four-edge clamp so the 288px menu can't
  // spill off-screen when the picker sits near a viewport edge (was
  // `absolute bottom-full left-0`).
  const popoverStyle = useAnchoredPopover(isOpen, anchorRef, popoverRef, {
    preferredSide: "top",
    align: "start",
    gap: 8,
  });

  useEffect(() => {
    popupOwned.current = false;
    restorePending.current = false;
    operationRef.current = null;
    setOpen(false);
    setPendingBranch(null);
    if (!projectId || !cwd) {
      setResolvedTarget(null);
      setState("unavailable");
      setBranches({ isRepo: false, current: null, branches: [] });
      setError(null);
      return;
    }

    let cancelled = false;
    setState("loading");
    setError(null);
    window.codeshell
      .getProjectGitBranches(projectId)
      .then((result) => {
        if (cancelled || targetRef.current !== target) return;
        setResolvedTarget(target);
        setBranches(result);
        setState(result.isRepo && result.branches.length > 0 ? "ready" : "unavailable");
      })
      .catch((err: unknown) => {
        if (cancelled || targetRef.current !== target) return;
        setResolvedTarget(null);
        setBranches({ isRepo: false, current: null, branches: [] });
        setError(err instanceof Error ? err.message : t("chat.branch.readFailed"));
        setState("error");
      });

    return () => {
      cancelled = true;
      popupOwned.current = false;
      restorePending.current = false;
      operationRef.current = null;
    };
  }, [cwd, projectId]);

  useLayoutEffect(() => {
    if (disabled) {
      popupOwned.current = false;
      restorePending.current = false;
      setOpen(false);
    }
  }, [disabled]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const onOutside = (event: PointerEvent | FocusEvent) => {
      const node = event.target as Node;
      if (wrapRef.current?.contains(node) || popoverRef.current?.contains(node)) return;
      popupOwned.current = false;
      restorePending.current = false;
      setOpen(false);
    };
    const onBlur = () => {
      popupOwned.current = false;
      restorePending.current = false;
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

  useLayoutEffect(() => {
    if (isOpen || !restorePending.current || !anchorRef.current) return;
    restorePending.current = false;
    if (document.activeElement === document.body && !anchorRef.current.disabled)
      anchorRef.current.focus({ preventScroll: true });
  }, [isOpen, state]);

  useLayoutEffect(() => {
    if (!isOpen || popoverStyle.visibility !== "visible") return;
    const active = document.activeElement;
    if (
      !popoverRef.current?.contains(active) &&
      active !== anchorRef.current &&
      !(active === document.body && popupOwned.current)
    )
      return;
    const next =
      branches.branches.find((branch) => branch === focusedBranch) ??
      branches.current ??
      branches.branches[0];
    const node = pendingBranch
      ? popoverRef.current?.contains(active) && active instanceof HTMLElement
        ? active
        : cancelRef.current
      : next
        ? optionRefs.current.get(next)
        : null;
    if (!node) return;
    if (!pendingBranch && next !== focusedBranch) setFocusedBranch(next);
    if (node !== active) node.focus({ preventScroll: true });
    popupOwned.current = true;
    const list = pendingBranch ? popoverRef.current : listRef.current;
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    const key = pendingBranch ? (node === cancelRef.current ? "cancel" : "stash") : next;
    const layout = `${key}:${bounds.top}:${list.clientHeight}:${node.offsetHeight}`;
    // Scroll events also update anchoring. Keep intentional wheel movement.
    if (layout === focusedLayout.current) return;
    focusedLayout.current = layout;
    const top = bounds.top + list.clientTop;
    const bottom = top + list.clientHeight;
    const box = node.getBoundingClientRect();
    if (box.top < top - 1) list.scrollTop += box.top - top;
    else if (box.bottom > bottom + 1) list.scrollTop += box.bottom - bottom;
  }, [branches, focusedBranch, isOpen, pendingBranch, popoverStyle]);

  const closeMenu = (restore = false) => {
    const active = document.activeElement;
    const owned =
      popoverRef.current?.contains(active) ||
      active === anchorRef.current ||
      (active === document.body && popupOwned.current);
    restorePending.current = !!restore && !!owned;
    popupOwned.current = false;
    setPendingBranch(null);
    setOpen(false);
    if (restorePending.current && anchorRef.current && !anchorRef.current.disabled) {
      restorePending.current = false;
      anchorRef.current.focus({ preventScroll: true });
    }
  };
  const openMenu = (last = false) => {
    if (disabled || state !== "ready") return;
    anchorRef.current?.focus({ preventScroll: true });
    popupOwned.current = true;
    restorePending.current = false;
    focusedLayout.current = "";
    setPendingBranch(null);
    setFocusedBranch(
      branches.current ?? branches.branches[last ? branches.branches.length - 1 : 0] ?? null,
    );
    setOpen(true);
  };
  const composing = (event: React.KeyboardEvent) =>
    event.nativeEvent.isComposing || event.keyCode === 229;
  const onPopupKeyDown = (event: React.KeyboardEvent) => {
    if (composing(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "Tab") {
      // Continue from the composer trigger instead of the body's portal order.
      if (!pendingBranch || (event.shiftKey && event.target === cancelRef.current)) closeMenu(true);
      else if (!event.shiftKey && event.target === stashRef.current) closeMenu(true);
    } else if (!pendingBranch && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (busy || !branches.branches.length) return;
      focusedLayout.current = "";
      const index = branches.branches.indexOf(focusedBranch ?? "");
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? branches.branches.length - 1
            : Math.max(
                0,
                Math.min(
                  index + (event.key === "ArrowDown" ? 1 : -1),
                  branches.branches.length - 1,
                ),
              );
      const branch = branches.branches[next];
      setFocusedBranch(branch);
      const node = optionRefs.current.get(branch);
      node?.focus({ preventScroll: true });
      const list = listRef.current;
      if (node && list) {
        const bounds = list.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        const top = bounds.top + list.clientTop;
        const bottom = top + list.clientHeight;
        if (box.top < top - 1) list.scrollTop += box.top - top;
        else if (box.bottom > bottom + 1) list.scrollTop += box.bottom - bottom;
      }
    }
  };

  const canOpen = !disabled && state === "ready";
  const label = (() => {
    if (state === "loading") return t("chat.branch.loading");
    if (branches.branches.length === 0) return t("chat.branch.noLocalBranches");
    return branches.current ?? t("chat.branch.detached");
  })();

  const switchBranch = async (branch: string, operation: object, stash = false): Promise<void> => {
    if (!projectId || !cwd) return;
    try {
      const next = stash
        ? await window.codeshell.stashAndSwitchProjectGitBranch(projectId, branch)
        : await window.codeshell.switchProjectGitBranch(projectId, branch);
      notifyGitBranchesChanged(cwd);
      if (targetRef.current !== target || operationRef.current !== operation) return;
      setBranches(next);
      setState(next.isRepo && next.branches.length > 0 ? "ready" : "unavailable");
      closeMenu(true);
    } catch (err) {
      if (targetRef.current !== target || operationRef.current !== operation) return;
      setError(
        err instanceof Error
          ? err.message
          : t(stash ? "chat.branch.stashFailed" : "chat.branch.switchFailed"),
      );
      setState("ready");
    }
  };

  const stashAndSwitch = async (): Promise<void> => {
    if (!projectId || !cwd || !pendingBranch || disabled || operationRef.current) return;
    const operation = {};
    operationRef.current = operation;
    setState("loading");
    setError(null);
    try {
      await switchBranch(pendingBranch, operation, true);
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
    }
  };

  const choose = async (branch: string): Promise<void> => {
    if (!projectId || !cwd || disabled || operationRef.current || state !== "ready") return;
    if (branch === branches.current) {
      closeMenu(true);
      return;
    }
    const operation = {};
    operationRef.current = operation;
    setState("loading");
    setError(null);
    try {
      const status = await window.codeshell.getProjectGitStatus(projectId);
      if (targetRef.current !== target || operationRef.current !== operation) return;
      // Dismissal during the status probe cancels an action that has not begun.
      if (!popupOwned.current) {
        setState("ready");
        return;
      }
      if (!status.clean) {
        setState("ready");
        setPendingBranch(branch);
        return;
      }
      await switchBranch(branch, operation);
    } catch (err) {
      if (targetRef.current !== target || operationRef.current !== operation) return;
      setError(err instanceof Error ? err.message : t("chat.branch.switchFailed"));
      setState("ready");
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
    }
  };

  // A result belongs to one project/workspace selection. Hide immediately on
  // selection changes, before the loading effect can clear the previous label.
  if (!projectId || !cwd || resolvedTarget !== target || !branches.isRepo) return null;

  return (
    <div className="relative" ref={wrapRef}>
      <Button
        ref={anchorRef}
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1 px-2 text-xs disabled:opacity-50 aria-disabled:opacity-50"
        disabled={disabled || (!canOpen && !busy)}
        aria-disabled={busy || disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popupId : undefined}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowUp");
          } else if (event.key === "Escape" && isOpen) {
            event.preventDefault();
            event.stopPropagation();
            closeMenu(true);
          }
        }}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
        title={
          error ?? (clean === false ? t("chat.branch.dirtyTitle") : t("chat.branch.switchTitle"))
        }
      >
        <GitBranch size={12} />
        <span className="max-w-32 truncate text-xs font-medium">{label}</span>
        {clean === false && canOpen && <span className="h-1.5 w-1.5 rounded-full bg-status-warn" />}
        <ChevronDown size={11} />
      </Button>

      {isOpen &&
        createPortal(
          <div
            ref={popoverRef}
            id={popupId}
            role="dialog"
            aria-label={t("chat.branch.switchTitle")}
            aria-busy={busy}
            onKeyDown={onPopupKeyDown}
            style={{ ...popoverStyle, overflowY: pendingBranch ? "auto" : "hidden" }}
            className="flex min-h-0 w-72 flex-col rounded-md border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            {error && (
              <div
                role="alert"
                className="max-h-24 shrink-0 overflow-y-auto rounded bg-status-err/10 p-2 text-xs text-status-err [overflow-wrap:anywhere]"
              >
                {error}
              </div>
            )}
            {pendingBranch ? (
              <div className="rounded-md border p-3">
                <div className="font-medium text-foreground">{t("chat.branch.dirtyHeading")}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t("chat.branch.stashNeeded", { branch: pendingBranch })}
                </div>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    ref={cancelRef}
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (!busy) {
                        focusedLayout.current = "";
                        setPendingBranch(null);
                      }
                    }}
                    aria-disabled={busy}
                  >
                    {t("chat.branch.cancel")}
                  </Button>
                  <Button
                    type="button"
                    ref={stashRef}
                    variant="outline"
                    size="sm"
                    className="border-primary/40 text-primary hover:bg-primary/10"
                    aria-disabled={busy}
                    onClick={() => {
                      void stashAndSwitch();
                    }}
                  >
                    {t("chat.branch.stashAndSwitch")}
                  </Button>
                </div>
              </div>
            ) : (
              <ul
                ref={listRef}
                role="listbox"
                aria-label={t("chat.branch.switchTitle")}
                className="min-h-0 max-h-64 overflow-y-auto py-1"
              >
                {branches.branches.map((branch) => {
                  const active = branch === branches.current;
                  return (
                    <li key={branch} role="none">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        role="option"
                        aria-selected={active}
                        aria-disabled={busy}
                        title={branch}
                        tabIndex={branch === focusedBranch ? 0 : -1}
                        ref={(node) => {
                          if (node) optionRefs.current.set(branch, node);
                          else optionRefs.current.delete(branch);
                        }}
                        onFocus={() => setFocusedBranch(branch)}
                        className={cn(
                          "h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-sm font-normal aria-disabled:opacity-50",
                          active && "bg-accent",
                        )}
                        onClick={() => {
                          void choose(branch);
                        }}
                      >
                        <GitBranch size={12} className="shrink-0 opacity-60" />
                        <span className="min-w-0 flex-1 truncate text-left">{branch}</span>
                        {active && <Check size={12} className="text-primary" />}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
