import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAlert } from "../ui/DialogProvider";
import { useT } from "../i18n/I18nProvider";
import { notifySettingsChanged } from "../settingsBus";
import { Puzzle } from "lucide-react";
import { PluginInstallJobsPanel } from "./PluginInstallJobsPanel";

interface Props {
  cwd: string;
  marketName: string;
  onBack: () => void;
  onInstalled: () => void;
}

type Marketplace = Awaited<
  ReturnType<typeof window.codeshell.loadMarketplace>
>;
type PluginInstallJob = Awaited<
  ReturnType<typeof window.codeshell.listPluginInstallJobs>
>[number];

export function MarketDetail({ cwd, marketName, onBack, onInstalled }: Props) {
  const { t } = useT();
  const [market, setMarket] = useState<Marketplace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [installJobs, setInstallJobs] = useState<PluginInstallJob[]>([]);
  const alert = useAlert();
  const seenInstalledJobs = useRef<Set<string>>(new Set());
  // plugin name → installed version (git short SHA or "local"); presence = installed.
  const [installed, setInstalled] = useState<Map<string, string>>(new Map());

  const retry = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    setMarket(null);
    setLoaded(false);
    setError(null);
    // Load the marketplace manifest and the already-installed plugins in
    // parallel, so plugins installed in a previous session show 已安装 on
    // entry — not only the ones installed during this visit.
    Promise.all([
      window.codeshell.loadMarketplace(marketName),
      window.codeshell.listPlugins(cwd).catch(() => []),
    ])
      .then(([mp, plugins]) => {
        if (!alive) return;
        // installKey is "<plugin>@<marketplace>" — pick the ones from this
        // marketplace and seed them as installed (with their installed version).
        const here = new Map<string, string>();
        for (const p of plugins) {
          const at = p.installKey.lastIndexOf("@");
          if (at > 0 && p.installKey.slice(at + 1) === marketName) {
            here.set(p.installKey.slice(0, at), p.version);
          }
        }
        setInstalled(here);
        setMarket(mp);
        setLoaded(true);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [cwd, marketName, reloadKey]);

  useEffect(() => {
    let alive = true;
    window.codeshell
      .listPluginInstallJobs()
      .then((jobs) => {
        if (alive) setInstallJobs(jobs);
      })
      .catch(() => {
        if (alive) setInstallJobs([]);
      });
    const off = window.codeshell.onPluginInstallJobsChanged((jobs) => {
      if (alive) setInstallJobs(jobs);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    for (const job of installJobs) {
      if (job.marketplaceName !== marketName || job.status !== "installed") continue;
      if (seenInstalledJobs.current.has(job.id)) continue;
      seenInstalledJobs.current.add(job.id);
      setInstalled((prev) => new Map(prev).set(job.pluginName, prev.get(job.pluginName) ?? ""));
      notifySettingsChanged();
      onInstalled();
      setReloadKey((k) => k + 1);
    }
  }, [installJobs, marketName, onInstalled]);

  const install = async (pluginName: string) => {
    try {
      const res = await window.codeshell.installPlugin(pluginName, marketName);
      if (!res.ok) {
        void alert({ title: t("ext.market.installFailedTitle"), message: res.error ?? t("ext.market.unknownError") });
        return;
      }
    } catch (e) {
      void alert({ title: t("ext.market.installFailedTitle"), message: String((e as Error)?.message ?? e) });
    }
  };

  const retryInstallJob = async (id: string) => {
    const res = await window.codeshell.retryPluginInstallJob(id);
    if (!res.ok) {
      void alert({ title: t("ext.market.installFailedTitle"), message: res.error ?? t("ext.market.unknownError") });
    }
  };

  const buttonLabel = (job: PluginInstallJob | undefined, isInstalled: boolean): string => {
    if (isInstalled) return t("ext.market.installed");
    if (job?.status === "queued") return t("ext.market.jobQueued");
    if (job?.status === "installing") return t("ext.market.installing");
    if (job?.status === "failed") return t("ext.market.retryInstall");
    return t("ext.market.install");
  };

  if (error)
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        {t("ext.common.loadFailed", { error })} <Button size="sm" variant="outline" onClick={retry}>{t("ext.common.retry")}</Button>
      </div>
    );
  if (!loaded) return <div className="p-4 text-sm text-muted-foreground">{t("ext.common.loading")}</div>;
  if (market === null)
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        {t("ext.market.manifestLoadFailed")} <Button size="sm" variant="outline" onClick={retry}>{t("ext.common.retry")}</Button>
      </div>
    );

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-sm text-muted-foreground hover:text-foreground" onClick={onBack}>
          ‹ {t("ext.common.back")}
        </Button>
        <span className="font-semibold">{market.name}</span>
      </div>
      <PluginInstallJobsPanel
        jobs={installJobs.filter((job) => job.marketplaceName === marketName)}
        onRetry={retryInstallJob}
      />
      {market.plugins.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">{t("ext.market.noPlugins")}</div>
      ) : (
        <ul className="space-y-1">
          {market.plugins.map((p) => {
            const job = installJobs.find((j) => j.marketplaceName === marketName && j.pluginName === p.name);
            const isPending = job?.status === "queued" || job?.status === "installing";
            const isInstalled = installed.has(p.name) || job?.status === "installed";
            const installedVersion = installed.get(p.name);
            return (
              <li key={p.name} className="flex items-center gap-3 rounded-lg border bg-card p-3 text-sm">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                  <Puzzle className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 truncate">
                    <span className="truncate font-medium">{p.name}</span>
                    {p.version && (
                      <span className="shrink-0 text-xs text-muted-foreground">v{p.version}</span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {(p.description ?? "").split("\n")[0]}
                  </div>
                </div>
                {isInstalled && installedVersion && (
                  <span
                    className="text-xs text-muted-foreground"
                    title={t("ext.market.installedVersionTip")}
                  >
                    {t("ext.market.installedVersion", { version: installedVersion })}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {p.category ?? p.author ?? ""}
                </span>
                <Button
                  size="sm"
                  disabled={isPending || isInstalled}
                  onClick={() => {
                    if (job?.status === "failed") void retryInstallJob(job.id);
                    else void install(p.name);
                  }}
                >
                  {buttonLabel(job, isInstalled)}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
