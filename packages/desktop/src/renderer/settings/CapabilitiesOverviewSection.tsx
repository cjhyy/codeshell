/**
 * 能力总览 — unified, scope-aware capability view (spec §7.5).
 *
 * Left: a scope picker (用户 + each project from repos.ts). Right: the
 * selected scope's capability workspace, grouped by kind. The core
 * CapabilityService projects builtin tools / MCP servers / skills / plugins
 * into one uniform descriptor list.
 *
 *   - 用户(全局) node  → two-state Switch, writes the global settings key
 *     via setCapabilityEnabled(scope:"user").
 *   - 项目 node        → three-state 继承/开/关 segmented control, writes the project's
 *     capabilityOverrides via setCapabilityOverride. "继承" deletes the key.
 *
 * Each row shows the effective value and flags "本项目覆盖" when the project
 * overrides the global baseline (descriptor.effectiveSource === "project").
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CapabilityDescriptor } from "@cjhyy/code-shell-core";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FolderGit2,
  Globe2,
  Layers,
  Plug,
  Puzzle,
  RotateCcw,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import type { Repo } from "../repos";
import { repoLabel } from "../repos";
import { cacheGet, cacheSet } from "./settingsCache";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  type CapabilityKind,
  capabilityMeta,
  groupCapabilities,
  isGroupCollapsed,
} from "./capabilitiesOverview";

type ScopeNode = { kind: "user" } | { kind: "project"; repoPath: string; label: string };
type ProjectState = "inherit" | "on" | "off";
type LucideIcon = React.ComponentType<{ size?: number; className?: string }>;

interface Props {
  repos: Repo[];
  /**
   * Click a capability row's info area → jump to that kind's dedicated detail
   * tab. The parent maps the kind to a settings module (mcp/skill/plugin/agent);
   * builtin has no detail tab, so its rows are not clickable.
   */
  onNavigateToKind?: (kind: CapabilityKind) => void;
}

const KIND_ICON: Record<CapabilityKind, LucideIcon> = {
  mcp: Plug,
  skill: Sparkles,
  plugin: Puzzle,
  agent: Bot,
  builtin: Wrench,
};

const PROJECT_STATE_META: Record<
  ProjectState,
  { label: string; Icon: LucideIcon; className: string }
> = {
  inherit: { label: "继承", Icon: RotateCcw, className: "is-inherit" },
  on: { label: "启用", Icon: Check, className: "is-on" },
  off: { label: "停用", Icon: X, className: "is-off" },
};

function effectiveLabel(cap: CapabilityDescriptor): string {
  return cap.enabled ? "当前启用" : "当前停用";
}

function baselineLabel(cap: CapabilityDescriptor): string {
  return (cap.globalEnabled ?? cap.enabled) ? "全局默认启用" : "全局默认停用";
}

function projectStateLabel(cap: CapabilityDescriptor): string {
  if (cap.projectOverride === "on") return "本项目启用";
  if (cap.projectOverride === "off") return "本项目停用";
  return "继承全局";
}

export function CapabilitiesOverviewSection({ repos, onNavigateToKind }: Props) {
  const [node, setNode] = useState<ScopeNode>({ kind: "user" });
  // Seed from the last-loaded user-scope snapshot (settingsCache) so a
  // remount (tab switch) renders synchronously instead of flashing "加载中".
  const [caps, setCaps] = useState<CapabilityDescriptor[]>(
    () => cacheGet<CapabilityDescriptor[]>("caps:") ?? [],
  );
  // Only true before the very first list arrives. Switching scopes refreshes
  // in the background (stale-while-revalidate) so the existing list — and the
  // scroll position — stays put instead of unmounting to a "加载中" line.
  const [loading, setLoading] = useState(() => cacheGet("caps:") === undefined);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  // Monotonic token: a slow earlier request can resolve after a newer scope
  // switch; only the latest load is allowed to commit its result.
  const loadSeq = useRef(0);
  // Kinds the user manually toggled away from their default collapse state.
  // Anything not in here falls back to isCollapsedByDefault (builtin folded).
  const [toggled, setToggled] = useState<Set<CapabilityKind>>(() => new Set());

  const toggleGroup = (kind: CapabilityKind) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const cwd = node.kind === "project" ? node.repoPath : "";

  const load = async () => {
    const seq = ++loadSeq.current;
    setError(null);
    try {
      // Non-empty cwd → project overlay view; empty → user/global view.
      const next = await window.codeshell.listCapabilities(cwd);
      if (seq !== loadSeq.current) return; // a newer scope switch won
      setCaps(next);
      cacheSet(`caps:${cwd}`, next);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // First load drops the loading shell; later refreshes never re-raise it.
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const onUserToggle = async (cap: CapabilityDescriptor, next: boolean) => {
    const prev = caps;
    setCaps((cs) => cs.map((c) => (c.id === cap.id ? { ...c, enabled: next } : c)));
    setSavingId(cap.id);
    setError(null);
    try {
      await window.codeshell.setCapabilityEnabled("", cap.id, next, { scope: "user" });
    } catch (e) {
      setCaps(prev);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  };

  const onProjectState = async (
    cap: CapabilityDescriptor,
    state: "inherit" | "on" | "off",
  ) => {
    setSavingId(cap.id);
    setError(null);
    try {
      await window.codeshell.setCapabilityOverride(cwd, cap.id, state);
      // Re-fetch so the row's effective value / source reflects the new overlay.
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  };

  const groups = groupCapabilities(caps);
  const selectedProject = node.kind === "project";
  const summary = useMemo(() => {
    const enabled = caps.filter((c) => c.enabled).length;
    const overridden = caps.filter((c) => c.effectiveSource === "project").length;
    return { total: caps.length, enabled, overridden };
  }, [caps]);
  const selectedTitle = selectedProject ? node.label : "用户(全局)";
  const selectedSubtitle = selectedProject
    ? "为这个项目单独覆盖 MCP、技能和插件"
    : "设置所有项目继承的默认能力";

  return (
    <section className="mb-6 flex flex-col gap-3">
      <div className="flex items-start gap-3 rounded-md border bg-card p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary" aria-hidden>
          <Layers size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">扩展能力</div>
          <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">能力总览</h3>
          <p className="m-0 text-xs text-muted-foreground">
            统一管理内置工具、MCP 服务器、技能、插件和子代理。先选全局默认，再为每个项目设置独立覆盖。
          </p>
        </div>
      </div>
      {error && <p className="rounded-md bg-status-err/10 p-2 text-sm text-status-err">{error}</p>}

      <div className="grid min-h-[420px] grid-cols-1 gap-3 lg:grid-cols-[240px_1fr]">
        <nav className="flex min-h-0 flex-col gap-1 rounded-md border p-2" aria-label="能力配置范围">
          <button
            type="button"
            className={cn(
              "flex items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left hover:bg-accent",
              node.kind === "user" && "border-primary bg-primary/10",
            )}
            onClick={() => setNode({ kind: "user" })}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground" aria-hidden>
              <Globe2 size={15} />
            </span>
            <span className="min-w-0 flex flex-col">
              <span className="truncate text-sm font-medium text-foreground">用户(全局)</span>
              <span className="truncate text-xs text-muted-foreground">默认配置</span>
            </span>
          </button>
          <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">项目配置</div>
          {repos.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">尚无项目</div>
          )}
          {repos.map((r) => {
            const label = repoLabel(r);
            const active = node.kind === "project" && node.repoPath === r.path;
            return (
              <button
                type="button"
                key={r.id}
                className={cn(
                  "flex items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left hover:bg-accent",
                  active && "border-primary bg-primary/10",
                )}
                title={r.path}
                onClick={() => setNode({ kind: "project", repoPath: r.path, label })}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground" aria-hidden>
                  <FolderGit2 size={15} />
                </span>
                <span className="min-w-0 flex flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{label}</span>
                  <span className="truncate text-xs text-muted-foreground">{r.path}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="min-h-0 rounded-md border p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground" aria-hidden>
                {selectedProject ? <FolderGit2 size={16} /> : <Globe2 size={16} />}
              </span>
              <span className="min-w-0 flex flex-col">
                <strong>{selectedTitle}</strong>
                <span>{selectedSubtitle}</span>
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-label="能力统计">
              <span>{summary.total} 项能力</span>
              <span>{summary.enabled} 项启用</span>
              {selectedProject && <span>{summary.overridden} 项本项目覆盖</span>}
            </div>
          </div>

          {loading && <p className="m-0 text-xs text-muted-foreground">加载中…</p>}
          {!loading && groups.length === 0 && (
            <p className="m-0 text-xs text-muted-foreground">暂无可管理的能力。</p>
          )}
          {!loading &&
            groups.map((g) => {
              const collapsed = isGroupCollapsed(toggled, g.kind);
              return (
              <div className="border-b last:border-b-0" key={g.kind}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroup(g.kind)}
                >
                  <span className="text-muted-foreground" aria-hidden>
                    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </span>
                  <span className="text-muted-foreground" aria-hidden>
                    {React.createElement(KIND_ICON[g.kind], { size: 15 })}
                  </span>
                  <span>{g.label}</span>
                  <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{g.items.length}</span>
                </button>
                {!collapsed && g.items.map((cap) => {
                  const meta = capabilityMeta(cap);
                  const overridden = cap.effectiveSource === "project";
                  // builtin has no dedicated detail tab, so its rows don't navigate.
                  const navigable = !!onNavigateToKind && cap.kind !== "builtin";
                  return (
                    <div className="flex items-center gap-3 px-2 py-2 text-sm" key={cap.id}>
                      <span
                        className={cn(
                          "cap-overview-info",
                          navigable && "cursor-pointer hover:text-foreground",
                        )}
                        role={navigable ? "button" : undefined}
                        tabIndex={navigable ? 0 : undefined}
                        title={navigable ? `打开${g.label}详情` : undefined}
                        onClick={navigable ? () => onNavigateToKind?.(cap.kind) : undefined}
                        onKeyDown={
                          navigable
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  onNavigateToKind?.(cap.kind);
                                }
                              }
                            : undefined
                        }
                      >
                        <span className="font-medium text-foreground">{cap.name}</span>
                        {cap.description && (
                          <span className="text-xs text-muted-foreground">{cap.description}</span>
                        )}
                        <span className="flex shrink-0 flex-wrap items-center gap-1">
                          <span
                            className={cn(
                              "cap-overview-status",
                              cap.enabled ? "is-enabled" : "is-disabled",
                            )}
                          >
                            {cap.enabled ? <Check size={12} /> : <Circle size={12} />}
                            {effectiveLabel(cap)}
                          </span>
                          {selectedProject && (
                            <span className={cn("cap-overview-status", overridden && "is-project")}>
                              {projectStateLabel(cap)}
                            </span>
                          )}
                          {selectedProject && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{baselineLabel(cap)}</span>}
                          {meta && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{meta}</span>}
                        </span>
                      </span>
                      {node.kind === "user" ? (
                        <Switch
                          checked={cap.enabled}
                          disabled={savingId === cap.id}
                          onCheckedChange={(v) => void onUserToggle(cap, v)}
                        />
                      ) : (
                        <div
                          className="ml-auto flex items-center gap-2"
                          aria-label={`${cap.name} 项目覆盖`}
                        >
                          {(["inherit", "on", "off"] as ProjectState[]).map((state) => {
                            const stateMeta = PROJECT_STATE_META[state];
                            const active = (cap.projectOverride ?? "inherit") === state;
                            return (
                              <button
                                type="button"
                                key={state}
                                className={cn(
                                  "cap-overview-state-btn",
                                  stateMeta.className,
                                  active && "active",
                                )}
                                disabled={savingId === cap.id}
                                onClick={() => void onProjectState(cap, state)}
                              >
                                <stateMeta.Icon size={13} />
                                {stateMeta.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              );
            })}
        </div>
      </div>
    </section>
  );
}
