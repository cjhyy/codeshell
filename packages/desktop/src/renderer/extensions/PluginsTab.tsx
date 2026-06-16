import { useEffect, useState } from "react";
import type { PluginSummary } from "../../main/plugins-service";
import { resolveUninstallTarget } from "./uninstallTarget";
import { PluginDetailView } from "./PluginDetailView";
import { MoreHorizontal, Loader2, ArrowUpCircle, ChevronRight } from "lucide-react";
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
import { signalHotReload, runBatchUpdate, summarizeBatch } from "./applyUpdates";

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
  // installKey → has-newer-commit-upstream. Filled in asynchronously after the
  // list renders; only remote plugins ever flip to true (core returns false for
  // local/no-commit sources), so the badge silently no-ops for everything else.
  const [updatable, setUpdatable] = useState<Record<string, boolean>>({});
  // List→detail (same pattern as MarketList→MarketDetail): selected installKey.
  const [selected, setSelected] = useState<string | null>(null);
  const retry = () => setReloadKey((k) => k + 1);
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    setPlugins(null);
    setError(null);
    setUpdatable({});
    window.codeshell
      .listPlugins(cwd)
      .then((d) => {
        if (!alive) return;
        setPlugins(d);
        // Background, non-blocking: probe each plugin for an upstream update
        // (network per plugin; core no-ops fast for non-remote sources). Each
        // resolves independently so badges appear as they come back.
        for (const p of d) {
          window.codeshell
            .checkPluginUpdate(p.name)
            .then((r) => {
              if (alive && r.updateAvailable) {
                setUpdatable((m) => ({ ...m, [p.installKey]: true }));
              }
            })
            .catch(() => {
              /* check failure → just no badge */
            });
        }
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
      // Hot-reload: skills/commands are disk-scanned live (next turn picks them
      // up); hooks/MCP re-reconcile off this event on every running session.
      if (r.updated) signalHotReload();
      toast(
        r.updated
          ? { message: `已更新 “${p.name}”，已生效`, variant: "success" }
          : { message: `“${p.name}”：${r.reason}` },
      );
    } catch (e) {
      // Atomic in core — the old version is kept on failure.
      void alert({ title: "更新失败", message: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(null);
    }
  };
  const updateAll = async () => {
    const targets = (plugins ?? []).filter((p) => updatable[p.installKey]);
    if (targets.length === 0) return;
    setBusy("__all__");
    try {
      const labelByName = new Map(targets.map((p) => [p.name, p.name]));
      const outcomes = await runBatchUpdate(
        targets.map((p) => p.name),
        (name) => labelByName.get(name) ?? name,
        (name) => window.codeshell.updatePlugin(name),
      );
      setReloadKey((k) => k + 1);
      onChanged();
      if (outcomes.some((o) => o.updated)) signalHotReload();
      const s = summarizeBatch(outcomes);
      toast({ message: s.message, variant: s.ok ? "success" : undefined });
    } finally {
      setBusy(null);
    }
  };

  if (selected !== null) {
    return <PluginDetailView installKey={selected} onBack={() => setSelected(null)} />;
  }
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
  const updatableCount = rows.filter((p) => updatable[p.installKey]).length;
  return (
    <div className="space-y-2">
      {updatableCount > 1 && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={busy !== null}
            onClick={() => void updateAll()}
          >
            {busy === "__all__" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-3.5 w-3.5" />
            )}
            全部更新 ({updatableCount})
          </Button>
        </div>
      )}
      <ul className="space-y-1">
      {rows.map((p) => (
        <li key={p.installKey} className="flex items-center gap-3 rounded-md border p-3 text-sm">
          <span className="text-lg">🧩</span>
          <button
            type="button"
            className="group flex min-w-0 flex-1 items-center gap-1 text-left"
            onClick={() => setSelected(p.installKey)}
            title="查看插件内容(skills / commands / agents / hooks / MCP)"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium group-hover:underline">{p.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {p.sourceLabel} · {p.skillCount} skills
              </div>
            </div>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
          </button>
          {updatable[p.installKey] && (
            <Button
              size="icon"
              variant="ghost"
              title="有新版本，点击更新"
              className="text-status-running hover:text-status-running"
              disabled={busy === p.installKey}
              onClick={() => void update(p)}
            >
              {busy === p.installKey ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUpCircle className="h-4 w-4" />
              )}
            </Button>
          )}
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
    </div>
  );
}
