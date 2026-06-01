/**
 * 能力总览 — unified, scope-aware capability view (spec §7.5).
 *
 * Left: a two-level tree (用户 + each project from repos.ts). Right: the
 * selected scope's capability list, grouped by kind. The core
 * CapabilityService projects builtin tools / MCP servers / skills / plugins
 * into one uniform descriptor list.
 *
 *   - 用户(全局) node  → two-state Switch, writes the global settings key
 *     via setCapabilityEnabled(scope:"user").
 *   - 项目 node        → three-state 继承/开/关 select, writes the project's
 *     capabilityOverrides via setCapabilityOverride. "继承" deletes the key.
 *
 * Each row shows the effective value and flags "本项目覆盖" when the project
 * overrides the global baseline (descriptor.effectiveSource === "project").
 */
import React, { useEffect, useState } from "react";
import type { CapabilityDescriptor } from "@cjhyy/code-shell-core";
import type { Repo } from "../repos";
import { Switch } from "@/components/ui/switch";
import { SimpleSelect } from "@/components/ui/simple-select";
import { cn } from "@/lib/utils";
import {
  capabilityMeta,
  groupCapabilities,
} from "./capabilitiesOverview";

type ScopeNode = { kind: "user" } | { kind: "project"; repoPath: string; label: string };

interface Props {
  repos: Repo[];
}

const OVERRIDE_OPTIONS = [
  { value: "inherit", label: "继承" },
  { value: "on", label: "开" },
  { value: "off", label: "关" },
];

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

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">能力总览</h3>
      <p className="settings-section-help">
        所有可启停的能力(内置工具、MCP 服务器、技能、插件)集中在此统一开关。
        左侧选择用户(全局)或某个项目;项目级用继承/开/关三态覆盖全局默认。
      </p>
      {error && <p className="cap-overview-error">{error}</p>}

      <div className="flex gap-4">
        <nav className="w-44 shrink-0 space-y-1 text-sm">
          <button
            type="button"
            className={cn(
              "block w-full rounded px-2 py-1 text-left hover:bg-muted",
              node.kind === "user" && "bg-muted font-medium",
            )}
            onClick={() => setNode({ kind: "user" })}
          >
            用户(全局)
          </button>
          <div className="px-2 pt-2 text-xs uppercase text-muted-foreground">项目</div>
          {repos.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">尚无项目</div>
          )}
          {repos.map((r) => {
            const label = r.displayName || r.name;
            const active = node.kind === "project" && node.repoPath === r.path;
            return (
              <button
                type="button"
                key={r.id}
                className={cn(
                  "block w-full truncate rounded px-2 py-1 text-left hover:bg-muted",
                  active && "bg-muted font-medium",
                )}
                title={r.path}
                onClick={() => setNode({ kind: "project", repoPath: r.path, label })}
              >
                {label}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1">
          {loading && <p className="settings-section-help">加载中…</p>}
          {!loading && groups.length === 0 && (
            <p className="settings-section-help">暂无可管理的能力。</p>
          )}
          {!loading &&
            groups.map((g) => (
              <div className="cap-overview-group" key={g.kind}>
                <div className="cap-overview-group-head" aria-hidden>
                  {g.label}
                  <span className="cap-overview-group-count">{g.items.length}</span>
                </div>
                {g.items.map((cap) => {
                  const meta = capabilityMeta(cap);
                  const overridden = cap.effectiveSource === "project";
                  // builtin has no project override bucket — lock the project
                  // select for it (still togglable from the user scope).
                  const projectLocked = node.kind === "project" && cap.kind === "builtin";
                  return (
                    <div
                      className="settings-toggle-row cap-overview-row flex items-center justify-between"
                      key={cap.id}
                    >
                      <span className="cap-overview-info min-w-0">
                        <span className="cap-overview-name">
                          {cap.name}
                          {overridden && (
                            <span className="ml-2 text-xs text-status-warn">本项目覆盖</span>
                          )}
                        </span>
                        {cap.description && (
                          <span className="cap-overview-desc">{cap.description}</span>
                        )}
                        {meta && <span className="cap-overview-meta">{meta}</span>}
                      </span>
                      {node.kind === "user" ? (
                        <Switch
                          checked={cap.enabled}
                          disabled={savingId === cap.id}
                          onCheckedChange={(v) => void onUserToggle(cap, v)}
                        />
                      ) : (
                        <SimpleSelect
                          value={cap.projectOverride ?? "inherit"}
                          size="sm"
                          disabled={savingId === cap.id || projectLocked}
                          ariaLabel={`${cap.name} 项目覆盖`}
                          options={OVERRIDE_OPTIONS}
                          onChange={(v) =>
                            void onProjectState(cap, v as "inherit" | "on" | "off")
                          }
                        />
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
