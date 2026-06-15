import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch } from "lucide-react";
import type { GitBranches } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  cwd: string | null;
  clean?: boolean | null;
  disabled?: boolean;
}

type LoadState = "idle" | "loading" | "ready" | "unavailable" | "error";

export function BranchPicker({ cwd, clean, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>("idle");
  const [branches, setBranches] = useState<GitBranches>({ isRepo: false, current: null, branches: [] });
  const [error, setError] = useState<string | null>(null);
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cwd) {
      setOpen(false);
      setState("unavailable");
      setBranches({ isRepo: false, current: null, branches: [] });
      setError(null);
      return;
    }

    let cancelled = false;
    setState("loading");
    setError(null);
    window.codeshell
      .getGitBranches(cwd)
      .then((result) => {
        if (cancelled) return;
        setBranches(result);
        setState(result.isRepo && result.branches.length > 0 ? "ready" : "unavailable");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBranches({ isRepo: false, current: null, branches: [] });
        setError(err instanceof Error ? err.message : "无法读取分支");
        setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [cwd]);

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
    if (!cwd) return "No branch";
    if (state === "loading") return "Loading branch…";
    if (state === "error") return "非 Git 项目";
    if (!branches.isRepo) return "非 Git 项目";
    if (branches.branches.length === 0) return "无本地分支";
    return branches.current ?? "detached HEAD";
  })();

  const switchClean = async (branch: string): Promise<void> => {
    if (!cwd) return;
    const previous = branches;
    setState("loading");
    setError(null);
    try {
      const next = await window.codeshell.switchGitBranch(cwd, branch);
      setBranches(next);
      setState(next.isRepo && next.branches.length > 0 ? "ready" : "unavailable");
      setPendingBranch(null);
      setOpen(false);
    } catch (err) {
      setBranches(previous);
      setError(err instanceof Error ? err.message : "切换分支失败");
      setState("ready");
    }
  };

  const stashAndSwitch = async (): Promise<void> => {
    if (!cwd || !pendingBranch) return;
    const previous = branches;
    setState("loading");
    setError(null);
    try {
      const next = await window.codeshell.stashAndSwitchGitBranch(cwd, pendingBranch);
      setBranches(next);
      setState(next.isRepo && next.branches.length > 0 ? "ready" : "unavailable");
      setPendingBranch(null);
      setOpen(false);
    } catch (err) {
      setBranches(previous);
      setError(err instanceof Error ? err.message : "暂存并切换失败");
      setState("ready");
    }
  };

  const choose = async (branch: string): Promise<void> => {
    if (!cwd || branch === branches.current) {
      setOpen(false);
      return;
    }
    setError(null);
    try {
      const status = await window.codeshell.getGitStatus(cwd);
      if (!status.clean) {
        setPendingBranch(branch);
        return;
      }
      await switchClean(branch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换分支失败");
      setState("ready");
    }
  };

  return (
    <div className="relative" ref={wrapRef}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1 px-2 text-xs disabled:opacity-50"
        disabled={!canOpen}
        onClick={() => setOpen((o) => !o)}
        title={error ?? (clean === false ? "当前分支有未提交改动" : "切换 Git 分支")}
      >
        <GitBranch size={12} />
        <span className="max-w-32 truncate text-xs font-medium">{label}</span>
        {clean === false && canOpen && <span className="h-1.5 w-1.5 rounded-full bg-status-warn" />}
        <ChevronDown size={11} />
      </Button>

      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 w-72 rounded-md border bg-popover p-3 text-popover-foreground shadow-lg">
          {error && <div className="rounded bg-status-err/10 p-2 text-xs text-status-err">{error}</div>}
          {pendingBranch ? (
            <div className="rounded-md border p-3">
              <div className="font-medium text-foreground">当前有未提交改动</div>
              <div className="mt-1 text-xs text-muted-foreground">
                切换到 {pendingBranch} 前需要先暂存当前改动。
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setPendingBranch(null)}>
                  取消
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
                  暂存并切换
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
