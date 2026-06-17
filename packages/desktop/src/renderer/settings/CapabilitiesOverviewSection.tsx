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
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type CapabilityKind,
  groupCapabilities,
  isGroupCollapsed,
} from "./capabilitiesOverview";
import { useT } from "../i18n/I18nProvider";
import type { TFunction } from "../i18n/I18nProvider";

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

const PROJECT_STATE_ICON: Record<ProjectState, LucideIcon> = {
  inherit: RotateCcw,
  on: Check,
  off: X,
};

const KIND_LABEL_KEY: Record<CapabilityKind, string> = {
  mcp: "settingsX.capOverview.groupMcp",
  skill: "settingsX.capOverview.groupSkill",
  plugin: "settingsX.capOverview.groupPlugin",
  agent: "settingsX.capOverview.groupAgent",
  builtin: "settingsX.capOverview.groupBuiltin",
};

function kindLabel(t: TFunction, kind: CapabilityKind): string {
  return t(KIND_LABEL_KEY[kind] as Parameters<TFunction>[0]);
}

function metaText(t: TFunction, cap: CapabilityDescriptor): string {
  const parts: string[] = [];
  const count = cap.origin?.toolCount;
  if (typeof count === "number") parts.push(t("settingsX.capOverview.toolCount", { count }));
  if (cap.origin?.isReadOnly) parts.push(t("settingsX.capOverview.readOnly"));
  return parts.join(" · ");
}

function effectiveLabel(t: TFunction, cap: CapabilityDescriptor): string {
  return cap.enabled ? t("settingsX.capOverview.effectiveOn") : t("settingsX.capOverview.effectiveOff");
}

function baselineLabel(t: TFunction, cap: CapabilityDescriptor): string {
  return (cap.globalEnabled ?? cap.enabled)
    ? t("settingsX.capOverview.baselineOn")
    : t("settingsX.capOverview.baselineOff");
}

function projectStateLabel(t: TFunction, cap: CapabilityDescriptor): string {
  if (cap.projectOverride === "on") return t("settingsX.capOverview.projectOn");
  if (cap.projectOverride === "off") return t("settingsX.capOverview.projectOff");
  return t("settingsX.capOverview.projectInherit");
}

export function CapabilitiesOverviewSection({ repos, onNavigateToKind }: Props) {
  const { t } = useT();
  const PROJECT_STATE_LABEL: Record<ProjectState, string> = {
    inherit: t("settingsX.capOverview.inherit"),
    on: t("settingsX.capOverview.on"),
    off: t("settingsX.capOverview.off"),
  };
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
  const selectedTitle = selectedProject ? node.label : t("settingsX.capOverview.userGlobal");
  const selectedSubtitle = selectedProject
    ? t("settingsX.capOverview.selectedProjectSubtitle")
    : t("settingsX.capOverview.selectedUserSubtitle");

  return (
    <section className="mb-6 flex flex-col gap-3">
      <div className="flex items-start gap-3 rounded-md border bg-card p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary" aria-hidden>
          <Layers size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("settingsX.capOverview.header")}</div>
          <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">{t("settingsX.capOverview.title")}</h3>
          <p className="m-0 text-xs text-muted-foreground">
            {t("settingsX.capOverview.desc")}
          </p>
        </div>
      </div>
      {error && <p className="rounded-md bg-status-err/10 p-2 text-sm text-status-err">{error}</p>}

      <div className="grid min-h-[420px] grid-cols-1 gap-3 lg:grid-cols-[240px_1fr]">
        <nav className="flex min-h-0 flex-col gap-1 rounded-md border p-2" aria-label={t("settingsX.capOverview.scopeAria")}>
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "h-auto justify-start gap-2 px-2 py-2 text-left",
              node.kind === "user" && "bg-accent text-accent-foreground",
            )}
            onClick={() => setNode({ kind: "user" })}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground" aria-hidden>
              <Globe2 size={15} />
            </span>
            <span className="min-w-0 flex flex-col">
              <span className="truncate text-sm font-medium text-foreground">{t("settingsX.capOverview.userGlobal")}</span>
              <span className="truncate text-xs text-muted-foreground">{t("settingsX.capOverview.defaultConfig")}</span>
            </span>
          </Button>
          <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("settingsX.capOverview.projectConfig")}</div>
          {repos.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">{t("settingsX.capOverview.noProjects")}</div>
          )}
          {repos.map((r) => {
            const label = repoLabel(r);
            const active = node.kind === "project" && node.repoPath === r.path;
            return (
              <Button
                type="button"
                key={r.id}
                variant="ghost"
                className={cn(
                  "h-auto justify-start gap-2 px-2 py-2 text-left",
                  active && "bg-accent text-accent-foreground",
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
              </Button>
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
            <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-label={t("settingsX.capOverview.statsAria")}>
              <span>{t("settingsX.capOverview.statTotal", { count: summary.total })}</span>
              <span>{t("settingsX.capOverview.statEnabled", { count: summary.enabled })}</span>
              {selectedProject && <span>{t("settingsX.capOverview.statOverridden", { count: summary.overridden })}</span>}
            </div>
          </div>

          {loading && <p className="m-0 text-xs text-muted-foreground">{t("settingsX.capOverview.loading")}</p>}
          {!loading && groups.length === 0 && (
            <p className="m-0 text-xs text-muted-foreground">{t("settingsX.capOverview.none")}</p>
          )}
          {!loading &&
            groups.map((g) => {
              const collapsed = isGroupCollapsed(toggled, g.kind);
              return (
              <div className="border-b last:border-b-0" key={g.kind}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2 px-2 py-2 text-left text-sm"
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroup(g.kind)}
                >
                  <span className="text-muted-foreground" aria-hidden>
                    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </span>
                  <span className="text-muted-foreground" aria-hidden>
                    {React.createElement(KIND_ICON[g.kind], { size: 15 })}
                  </span>
                  <span>{kindLabel(t, g.kind)}</span>
                  <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{g.items.length}</span>
                </Button>
                {!collapsed && g.items.map((cap) => {
                  const meta = metaText(t, cap);
                  const overridden = cap.effectiveSource === "project";
                  // builtin has no dedicated detail tab, so its rows don't navigate.
                  const navigable = !!onNavigateToKind && cap.kind !== "builtin";
                  return (
                    <div className="flex items-center gap-3 px-2 py-2 text-sm" key={cap.id}>
                      <span
                        className={cn(
                          "min-w-0 flex flex-1 flex-col gap-1",
                          navigable && "cursor-pointer hover:text-foreground",
                        )}
                        role={navigable ? "button" : undefined}
                        tabIndex={navigable ? 0 : undefined}
                        title={navigable ? t("settingsX.capOverview.openDetail", { label: kindLabel(t, g.kind) }) : undefined}
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
                              "inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px]",
                              cap.enabled ? "text-status-ok" : "text-muted-foreground",
                            )}
                          >
                            {cap.enabled ? <Check size={12} /> : <Circle size={12} />}
                            {effectiveLabel(t, cap)}
                          </span>
                          {selectedProject && (
                            <span className={cn("inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground", overridden && "text-primary")}>
                              {projectStateLabel(t, cap)}
                            </span>
                          )}
                          {selectedProject && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{baselineLabel(t, cap)}</span>}
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
                          aria-label={t("settingsX.capOverview.projectOverrideAria", { name: cap.name })}
                        >
                          {(["inherit", "on", "off"] as ProjectState[]).map((state) => {
                            const StateIcon = PROJECT_STATE_ICON[state];
                            const active = (cap.projectOverride ?? "inherit") === state;
                            return (
                              <Button
                                type="button"
                                key={state}
                                variant="outline"
                                size="sm"
                                className={cn(
                                  "h-7 gap-1 px-2 text-xs",
                                  state === "on" && "text-status-ok",
                                  state === "off" && "text-status-err",
                                  active && "bg-accent",
                                )}
                                disabled={savingId === cap.id}
                                onClick={() => void onProjectState(cap, state)}
                              >
                                <StateIcon size={13} />
                                {PROJECT_STATE_LABEL[state]}
                              </Button>
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
