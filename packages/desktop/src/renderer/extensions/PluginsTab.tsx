import { useEffect, useState } from "react";
import type { PluginSummary } from "../../main/plugins-service";
import { resolveUninstallTarget } from "./uninstallTarget";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

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
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        加载失败：{error} <Button size="sm" variant="outline" onClick={retry}>重试</Button>
      </div>
    );
  if (plugins === null) return <div className="p-4 text-sm text-muted-foreground">加载中…</div>;
  const q = query.trim().toLowerCase();
  const rows = q
    ? plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description ?? "").toLowerCase().includes(q),
      )
    : plugins;
  if (rows.length === 0)
    return <div className="p-4 text-sm text-muted-foreground">还没有安装插件</div>;
  return (
    <ul className="space-y-1">
      {rows.map((p) => (
        <li key={p.installKey} className="flex items-center gap-3 rounded-md border p-3 text-sm">
          <span className="text-lg">🧩</span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{p.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {p.sourceLabel} · {p.skillCount} skills
            </div>
          </div>
          <span className="text-xs text-muted-foreground">{p.marketplace ?? "本地"}</span>
          <Switch checked={isEnabled(p)} onCheckedChange={(v) => onToggle(p, v)} />
          <Button
            size="icon"
            variant="ghost"
            title="卸载"
            disabled={busy === p.installKey}
            onClick={() => void uninstall(p)}
          >
            {busy === p.installKey ? "…" : "⋯"}
          </Button>
        </li>
      ))}
    </ul>
  );
}
