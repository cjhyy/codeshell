import { useEffect, useState } from "react";
import type { PluginSummary } from "../../main/plugins-service";
import { resolveUninstallTarget } from "./uninstallTarget";

interface Props {
  cwd: string;
  query: string;
  isEnabled: (p: PluginSummary) => boolean;
  onToggle: (p: PluginSummary, next: boolean) => void;
  onChanged: () => void;
}

export function PluginsTab({ cwd, query, isEnabled, onToggle, onChanged }: Props) {
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const retry = () => setReloadKey((k) => k + 1);
  useEffect(() => {
    let alive = true;
    setPlugins(null);
    setError(null);
    window.codeshell
      .listPlugins(cwd)
      .then((d) => {
        if (alive) setPlugins(d);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [cwd, reloadKey]);
  const uninstall = async (p: PluginSummary) => {
    const t = resolveUninstallTarget(p);
    if (!t.uninstallable) {
      window.alert("该插件为本地/直接安装，无法从这里卸载。");
      return;
    }
    if (!window.confirm(`确定卸载插件 “${p.name}”？`)) return;
    setBusy(p.installKey);
    try {
      await window.codeshell.uninstallPlugin(t.pluginName, t.marketplaceName);
      setReloadKey((k) => k + 1);
      onChanged();
    } catch (e) {
      window.alert(`卸载失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(null);
    }
  };
  if (error)
    return (
      <div className="customize-empty">
        加载失败：{error} <button onClick={retry}>重试</button>
      </div>
    );
  if (plugins === null) return <div className="customize-empty">加载中…</div>;
  const q = query.trim().toLowerCase();
  const rows = q
    ? plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description ?? "").toLowerCase().includes(q),
      )
    : plugins;
  if (rows.length === 0)
    return <div className="customize-empty">还没有安装插件</div>;
  return (
    <ul className="ext-list">
      {rows.map((p) => (
        <li key={p.installKey} className="ext-row">
          <span className="ext-row-icon">🧩</span>
          <div className="ext-row-main">
            <span className="ext-row-name">{p.name}</span>
            <span className="ext-row-desc">
              {p.sourceLabel} · {p.skillCount} skills
            </span>
          </div>
          <span className="ext-row-source">{p.marketplace ?? "本地"}</span>
          <input
            type="checkbox"
            checked={isEnabled(p)}
            onChange={(e) => onToggle(p, e.target.checked)}
          />
          <button
            className="ext-row-kebab"
            title="卸载"
            disabled={busy === p.installKey}
            onClick={() => void uninstall(p)}
          >
            {busy === p.installKey ? "…" : "⋯"}
          </button>
        </li>
      ))}
    </ul>
  );
}
