import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch } from "lucide-react";
import type { GitBranches } from "../../preload/types";

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
    if (!open) return;
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

  const choose = async (branch: string): Promise<void> => {
    if (!cwd || branch === branches.current) {
      setOpen(false);
      return;
    }
    const previous = branches;
    setState("loading");
    setError(null);
    try {
      const next = await window.codeshell.switchGitBranch(cwd, branch);
      setBranches(next);
      setState(next.isRepo && next.branches.length > 0 ? "ready" : "unavailable");
      setOpen(false);
    } catch (err) {
      setBranches(previous);
      setError(err instanceof Error ? err.message : "切换分支失败");
      setState("ready");
    }
  };

  return (
    <div className="branch-picker" ref={wrapRef}>
      <button
        type="button"
        className="composer-context-pill branch-picker-trigger"
        disabled={!canOpen}
        onClick={() => setOpen((o) => !o)}
        title={error ?? (clean === false ? "当前分支有未提交改动" : "切换 Git 分支")}
      >
        <GitBranch size={12} />
        <span className="composer-context-pill-label branch-picker-name">{label}</span>
        {clean === false && canOpen && <span className="composer-context-dirty-dot" />}
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="branch-picker-popover">
          {error && <div className="branch-picker-error">{error}</div>}
          <ul className="project-picker-list">
            {branches.branches.map((branch) => {
              const active = branch === branches.current;
              return (
                <li
                  key={branch}
                  className={`project-picker-item${active ? " active" : ""}`}
                  onClick={() => {
                    void choose(branch);
                  }}
                >
                  <GitBranch size={12} className="project-picker-item-icon" />
                  <span className="project-picker-item-label">{branch}</span>
                  {active && <Check size={12} className="project-picker-item-check" />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
