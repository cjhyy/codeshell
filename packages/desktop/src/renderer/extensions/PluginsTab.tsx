import { useEffect, useState } from "react";
import type { PluginSummary } from "../../main/plugins-service";
import { resolveUninstallTarget } from "./uninstallTarget";
import { MoreHorizontal, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useConfirm, useAlert } from "../ui/DialogProvider";
import { useToast } from "../ui/ToastProvider";

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
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();
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
      void alert({ title: "无法卸载", message: "该插件为本地/直接安装，无法从这里卸载。" });
      return;
    }
    const ok = await confirm({
      title: "卸载插件",
      message: `确定卸载插件 “${p.name}”？`,
      confirmLabel: "卸载",
      destructive: true,
    });
    if (!ok) return;
    setBusy(p.installKey);
    try {
      await window.codeshell.uninstallPlugin(t.pluginName, t.marketplaceName);
      setReloadKey((k) => k + 1);
      onChanged();
    } catch (e) {
      void alert({ title: "卸载失败", message: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(null);
    }
  };
  const update = async (p: PluginSummary) => {
    setBusy(p.installKey);
    try {
      const r = await window.codeshell.updatePlugin(p.name);
      setReloadKey((k) => k + 1);
      onChanged();
      // The update is fetched but not hot-reloaded — prompt to reload so the
      // running session picks up the new plugin code/skills (aligns with CC).
      toast(
        r.updated
          ? { message: `已更新 “${p.name}”，重载后生效`, variant: "success" }
          : { message: `“${p.name}”：${r.reason}` },
      );
    } catch (e) {
      // Atomic in core — the old version is kept on failure.
      void alert({ title: "更新失败", message: String((e as Error)?.message ?? e) });
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                title="更多操作"
                disabled={busy === p.installKey}
              >
                {busy === p.installKey ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MoreHorizontal className="h-4 w-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void update(p)}>更新</DropdownMenuItem>
              <DropdownMenuItem
                className="text-status-err focus:text-status-err"
                onSelect={() => void uninstall(p)}
              >
                卸载
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      ))}
    </ul>
  );
}
