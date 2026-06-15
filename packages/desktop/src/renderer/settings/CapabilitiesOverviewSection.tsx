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
    <section className="mb-6 flex flex-col gap-3 cap-overview">
      <div className="cap-overview-hero">
        <div className="cap-overview-hero-icon" aria-hidden>
          <Layers size={18} />
        </div>
        <div className="cap-overview-hero-copy">
          <div className="cap-overview-eyebrow">扩展能力</div>
          <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">能力总览</h3>
          <p className="m-0 text-xs text-muted-foreground">
            统一管理内置工具、MCP 服务器、技能、插件和子代理。先选全局默认，再为每个项目设置独立覆盖。
          </p>
        </div>
      </div>
      {error && <p className="cap-overview-error">{error}</p>}

      <div className="cap-overview-layout">
        <nav className="cap-overview-scope" aria-label="能力配置范围">
          <button
            type="button"
            className={cn(
              "cap-overview-scope-item",
              node.kind === "user" && "active",
            )}
            onClick={() => setNode({ kind: "user" })}
          >
            <span className="cap-overview-scope-icon" aria-hidden>
              <Globe2 size={15} />
            </span>
            <span className="cap-overview-scope-text">
              <span className="cap-overview-scope-title">用户(全局)</span>
              <span className="cap-overview-scope-subtitle">默认配置</span>
            </span>
          </button>
          <div className="cap-overview-scope-label">项目配置</div>
          {repos.length === 0 && (
            <div className="cap-overview-empty-scope">尚无项目</div>
          )}
          {repos.map((r) => {
            const label = repoLabel(r);
            const active = node.kind === "project" && node.repoPath === r.path;
            return (
              <button
                type="button"
                key={r.id}
                className={cn(
                  "cap-overview-scope-item",
                  active && "active",
                )}
                title={r.path}
                onClick={() => setNode({ kind: "project", repoPath: r.path, label })}
              >
                <span className="cap-overview-scope-icon" aria-hidden>
                  <FolderGit2 size={15} />
                </span>
                <span className="cap-overview-scope-text">
                  <span className="cap-overview-scope-title">{label}</span>
                  <span className="cap-overview-scope-subtitle">{r.path}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="cap-overview-main">
          <div className="cap-overview-panel-head">
            <div className="cap-overview-selected">
              <span className="cap-overview-selected-icon" aria-hidden>
                {selectedProject ? <FolderGit2 size={16} /> : <Globe2 size={16} />}
              </span>
              <span className="cap-overview-selected-copy">
                <strong>{selectedTitle}</strong>
                <span>{selectedSubtitle}</span>
              </span>
            </div>
            <div className="cap-overview-stats" aria-label="能力统计">
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
              <div className="cap-overview-group" key={g.kind}>
                <button
                  type="button"
                  className="cap-overview-group-head"
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroup(g.kind)}
                >
                  <span className="cap-overview-group-chevron" aria-hidden>
                    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </span>
                  <span className="cap-overview-group-icon" aria-hidden>
                    {React.createElement(KIND_ICON[g.kind], { size: 15 })}
                  </span>
                  <span>{g.label}</span>
                  <span className="cap-overview-group-count">{g.items.length}</span>
                </button>
                {!collapsed && g.items.map((cap) => {
                  const meta = capabilityMeta(cap);
                  const overridden = cap.effectiveSource === "project";
                  // builtin has no dedicated detail tab, so its rows don't navigate.
                  const navigable = !!onNavigateToKind && cap.kind !== "builtin";
                  return (
                    <div className="cap-overview-row" key={cap.id}>
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
                        <span className="cap-overview-name">{cap.name}</span>
                        {cap.description && (
                          <span className="cap-overview-desc">{cap.description}</span>
                        )}
                        <span className="cap-overview-row-tags">
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
                          {selectedProject && <span className="cap-overview-meta">{baselineLabel(cap)}</span>}
                          {meta && <span className="cap-overview-meta">{meta}</span>}
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
                          className="cap-overview-project-control"
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
