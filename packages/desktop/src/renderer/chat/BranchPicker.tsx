import React, { useEffect, useRef, useState } from "react";
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Anchored to the viewport with flip + four-edge clamp so the 288px menu can't
  // spill off-screen when the picker sits near a viewport edge (was
  // `absolute bottom-full left-0`).
  const popoverStyle = useAnchoredPopover(open, anchorRef, popoverRef, {
    preferredSide: "top",
    align: "start",
    gap: 8,
  });

  useEffect(() => {
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
    };
  }, [cwd, projectId]);

  useEffect(() => {
    if (!open) {
      setPendingBranch(null);
      return;
    }
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const canOpen = !disabled && state === "ready";
  const label = (() => {
    if (state === "loading") return t("chat.branch.loading");
    if (branches.branches.length === 0) return t("chat.branch.noLocalBranches");
    return branches.current ?? t("chat.branch.detached");
  })();

  const switchClean = async (branch: string): Promise<void> => {
    if (!projectId || !cwd) return;
    const previous = branches;
    setState("loading");
    setError(null);
    try {
      const next = await window.codeshell.switchProjectGitBranch(projectId, branch);
      notifyGitBranchesChanged(cwd);
      if (targetRef.current !== target) return;
      setBranches(next);
      setState(next.isRepo && next.branches.length > 0 ? "ready" : "unavailable");
      setPendingBranch(null);
      setOpen(false);
    } catch (err) {
      if (targetRef.current !== target) return;
      setBranches(previous);
      setError(err instanceof Error ? err.message : t("chat.branch.switchFailed"));
      setState("ready");
    }
  };

  const stashAndSwitch = async (): Promise<void> => {
    if (!projectId || !cwd || !pendingBranch) return;
    const previous = branches;
    setState("loading");
    setError(null);
    try {
      const next = await window.codeshell.stashAndSwitchProjectGitBranch(projectId, pendingBranch);
      notifyGitBranchesChanged(cwd);
      if (targetRef.current !== target) return;
      setBranches(next);
      setState(next.isRepo && next.branches.length > 0 ? "ready" : "unavailable");
      setPendingBranch(null);
      setOpen(false);
    } catch (err) {
      if (targetRef.current !== target) return;
      setBranches(previous);
      setError(err instanceof Error ? err.message : t("chat.branch.stashFailed"));
      setState("ready");
    }
  };

  const choose = async (branch: string): Promise<void> => {
    if (!projectId || !cwd || branch === branches.current) {
      setOpen(false);
      return;
    }
    setError(null);
    try {
      const status = await window.codeshell.getProjectGitStatus(projectId);
      if (targetRef.current !== target) return;
      if (!status.clean) {
        setPendingBranch(branch);
        return;
      }
      await switchClean(branch);
    } catch (err) {
      if (targetRef.current !== target) return;
      setError(err instanceof Error ? err.message : t("chat.branch.switchFailed"));
      setState("ready");
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
        className="h-8 gap-1 px-2 text-xs disabled:opacity-50"
        disabled={!canOpen}
        onClick={() => setOpen((o) => !o)}
        title={
          error ?? (clean === false ? t("chat.branch.dirtyTitle") : t("chat.branch.switchTitle"))
        }
      >
        <GitBranch size={12} />
        <span className="max-w-32 truncate text-xs font-medium">{label}</span>
        {clean === false && canOpen && <span className="h-1.5 w-1.5 rounded-full bg-status-warn" />}
        <ChevronDown size={11} />
      </Button>

      {open && (
        <div
          ref={popoverRef}
          style={popoverStyle}
          className="w-72 rounded-md border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          {error && (
            <div className="rounded bg-status-err/10 p-2 text-xs text-status-err">{error}</div>
          )}
          {pendingBranch ? (
            <div className="rounded-md border p-3">
              <div className="font-medium text-foreground">{t("chat.branch.dirtyHeading")}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t("chat.branch.stashNeeded", { branch: pendingBranch })}
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingBranch(null)}
                >
                  {t("chat.branch.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-primary/40 text-primary hover:bg-primary/10"
                  onClick={() => {
                    void stashAndSwitch();
                  }}
                >
                  {t("chat.branch.stashAndSwitch")}
                </Button>
              </div>
            </div>
          ) : (
            <ul className="max-h-64 overflow-y-auto py-1">
              {branches.branches.map((branch) => {
                const active = branch === branches.current;
                return (
                  <li
                    key={branch}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                      active && "bg-accent",
                    )}
                    onClick={() => {
                      void choose(branch);
                    }}
                  >
                    <GitBranch size={12} className="shrink-0 opacity-60" />
                    <span className="flex-1 truncate">{branch}</span>
                    {active && <Check size={12} className="text-primary" />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
