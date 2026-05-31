/**
 * 能力总览 — the unified capability view (#4).
 *
 * The backend CapabilityService projects builtin tools, MCP servers,
 * skills, and plugins into one uniform list, each carrying an inlined
 * `control` describing how to toggle it. This page lists them grouped by
 * kind with one switch per row; flipping a switch calls
 * `setCapabilityEnabled(cwd, id, on)` and the backend routes the write to
 * the right settings key. The older per-kind tabs (MCP / 扩展 / …) stay
 * for install/detail flows — this is the "see and toggle everything in
 * one place" surface, not a replacement for them.
 */
import React, { useEffect, useState } from "react";
import type { CapabilityDescriptor } from "@cjhyy/code-shell-core";
import {
  CAPABILITY_GROUP_ORDER,
  capabilityMeta,
  groupCapabilities,
  isCollapsedByDefault,
  type CapabilityKind,
} from "./capabilitiesOverview";

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

export function CapabilitiesOverviewSection({ scope, activeRepoPath }: Props) {
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;
  const [caps, setCaps] = useState<CapabilityDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // id of the row currently mid-write; locks just that switch.
  const [savingId, setSavingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<CapabilityKind>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.codeshell.listCapabilities(cwd ?? "");
      setCaps(list);
      // Seed collapsed state from the per-kind default on first load.
      setCollapsed(new Set(CAPABILITY_GROUP_ORDER.filter(isCollapsedByDefault)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, activeRepoPath]);

  const toggle = async (cap: CapabilityDescriptor, next: boolean) => {
    const prev = caps;
    // Optimistic update, then roll back if the write fails — the older
    // ToggleCapabilitySection silently swallowed errors; this doesn't.
    setCaps((cs) => cs.map((c) => (c.id === cap.id ? { ...c, enabled: next } : c)));
    setSavingId(cap.id);
    setError(null);
    try {
      await window.codeshell.setCapabilityEnabled(cwd ?? "", cap.id, next);
    } catch (e) {
      setCaps(prev);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  };

  const toggleGroup = (kind: CapabilityKind) => {
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(kind)) n.delete(kind);
      else n.add(kind);
      return n;
    });
  };

  const groups = groupCapabilities(caps);

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">能力总览</h3>
      <p className="settings-section-help">
        所有可启停的能力(内置工具、MCP 服务器、技能、插件)集中在此统一开关。安装与详情仍在各自页面。
      </p>
      {error && <p className="cap-overview-error">{error}</p>}
      {loading && <p className="settings-section-help">加载中…</p>}
      {!loading && groups.length === 0 && (
        <p className="settings-section-help">暂无可管理的能力。</p>
      )}
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.kind);
        return (
          <div className="cap-overview-group" key={g.kind}>
            <button
              type="button"
              className="cap-overview-group-head"
              aria-expanded={!isCollapsed}
              onClick={() => toggleGroup(g.kind)}
            >
              <span className="cap-overview-group-chevron">
                {isCollapsed ? "▸" : "▾"}
              </span>
              {g.label}
              <span className="cap-overview-group-count">{g.items.length}</span>
            </button>
            {!isCollapsed &&
              g.items.map((cap) => {
                const meta = capabilityMeta(cap);
                return (
                  <label className="settings-toggle-row cap-overview-row" key={cap.id}>
                    <span className="cap-overview-info">
                      <span className="cap-overview-name">{cap.name}</span>
                      {cap.description && (
                        <span className="cap-overview-desc">{cap.description}</span>
                      )}
                      {meta && <span className="cap-overview-meta">{meta}</span>}
                    </span>
                    <input
                      type="checkbox"
                      checked={cap.enabled}
                      disabled={savingId === cap.id}
                      onChange={(e) => void toggle(cap, e.target.checked)}
                    />
                  </label>
                );
              })}
          </div>
        );
      })}
    </section>
  );
}
