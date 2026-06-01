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
import React, { useEffect, useMemo, useState } from "react";
import type { CapabilityDescriptor } from "@cjhyy/code-shell-core";
import {
  Check,
  Circle,
  FolderGit2,
  Globe2,
  Hammer,
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
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  type CapabilityKind,
  capabilityMeta,
  groupCapabilities,
} from "./capabilitiesOverview";

type ScopeNode = { kind: "user" } | { kind: "project"; repoPath: string; label: string };
type ProjectState = "inherit" | "on" | "off";
type LucideIcon = React.ComponentType<{ size?: number; className?: string }>;

interface Props {
  repos: Repo[];
}

const KIND_ICON: Record<CapabilityKind, LucideIcon> = {
  mcp: Plug,
  skill: Sparkles,
  plugin: Puzzle,
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

export function CapabilitiesOverviewSection({ repos }: Props) {
  const [node, setNode] = useState<ScopeNode>({ kind: "user" });
  const [caps, setCaps] = useState<CapabilityDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const cwd = node.kind === "project" ? node.repoPath : "";

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // Non-empty cwd → project overlay view; empty → user/global view.
      setCaps(await window.codeshell.listCapabilities(cwd));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
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
    <section className="settings-section cap-overview">
      <div className="cap-overview-hero">
        <div className="cap-overview-hero-icon" aria-hidden>
          <Layers size={18} />
        </div>
        <div className="cap-overview-hero-copy">
          <div className="cap-overview-eyebrow">扩展能力</div>
          <h3 className="settings-section-title">能力总览</h3>
          <p className="settings-section-help">
            统一管理内置工具、MCP 服务器、技能和插件。先选全局默认，再为每个项目设置独立覆盖。
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

          {loading && <p className="settings-section-help">加载中…</p>}
          {!loading && groups.length === 0 && (
            <p className="settings-section-help">暂无可管理的能力。</p>
          )}
          {!loading &&
            groups.map((g) => (
              <div className="cap-overview-group" key={g.kind}>
                <div className="cap-overview-group-head">
                  <span className="cap-overview-group-icon" aria-hidden>
                    {React.createElement(KIND_ICON[g.kind], { size: 15 })}
                  </span>
                  <span>{g.label}</span>
                  <span className="cap-overview-group-count">{g.items.length}</span>
                </div>
                {g.items.map((cap) => {
                  const meta = capabilityMeta(cap);
                  const overridden = cap.effectiveSource === "project";
                  // builtin has no project override bucket, so project rows
                  // show the global value while staying togglable globally.
                  const projectLocked = node.kind === "project" && cap.kind === "builtin";
                  return (
                    <div className="cap-overview-row" key={cap.id}>
                      <span className="cap-overview-info">
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
                          className={cn(
                            "cap-overview-project-control",
                            projectLocked && "is-locked",
                          )}
                          aria-label={`${cap.name} 项目覆盖`}
                        >
                          {projectLocked ? (
                            <span className="cap-overview-locked">
                              <Hammer size={13} />
                              跟随全局
                            </span>
                          ) : (
                            (["inherit", "on", "off"] as ProjectState[]).map((state) => {
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
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}
