import { useEffect, useState } from "react";
import { MarketDetail } from "./MarketDetail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useConfirm, useAlert } from "../ui/DialogProvider";
import { useT } from "../i18n/I18nProvider";
import { Loader2, PlusCircle, ShoppingCart, Star } from "lucide-react";
import { PluginInstallJobsPanel } from "./PluginInstallJobsPanel";

interface Props {
  cwd: string;
  onInstalled: () => void;
}

type Marketplace = Awaited<
  ReturnType<typeof window.codeshell.listMarketplaces>
>[number];
type RecommendedMarketplaceList = Awaited<
  ReturnType<typeof window.codeshell.listRecommendedMarketplaces>
>;
type RecommendedMarketplace = RecommendedMarketplaceList["items"][number];
type PluginInstallJob = Awaited<
  ReturnType<typeof window.codeshell.listPluginInstallJobs>
>[number];
type GitCheckResult = Awaited<ReturnType<typeof window.codeshell.checkGit>>;

const FORMAT_BADGE: Record<
  Marketplace["format"],
  { label: string; variant: "accent" | "info" | "success" }
> = {
  // "universal" label is translated at render via t("ext.market.formatUniversal");
  // Claude Code / Codex are proper names kept as-is.
  "claude-code": { label: "Claude Code", variant: "accent" },
  codex: { label: "Codex", variant: "info" },
  universal: { label: "", variant: "success" },
};

// The official codeshell marketplace is cjhyy/mimi-plugins (github repo or its
// git URL form). Detected from the source rather than the local marketplace
// name so a renamed/re-added copy still gets the badge.
function isOfficialMarketplace(source: Marketplace["source"]): boolean {
  const ref =
    source.source === "github"
      ? source.repo
      : source.source === "git"
        ? source.url
        : "";
  return /(^|[/:])cjhyy\/mimi-plugins(\.git)?$/i.test(ref ?? "");
}

function sourceLabel(source: Marketplace["source"] | RecommendedMarketplace["source"]): string {
  return source.source === "github" ? `GitHub ${source.repo}` : source.url;
}

function sourcePathLabel(source: Marketplace["source"] | RecommendedMarketplace["source"]): string {
  if (source.source === "github") return source.repo.replace(/\.git$/i, "");
  const url = source.url.trim();
  const githubPath = url.replace(/\.git$/i, "").match(/github\.com[:/]([^?#]+)/i)?.[1];
  if (githubPath) return githubPath.replace(/^\/+|\/+$/g, "");
  return url;
}

function sourceKey(source: Marketplace["source"] | RecommendedMarketplace["source"]): string {
  return source.source === "github"
    ? `github:${source.repo.toLowerCase().replace(/\.git$/i, "")}`
    : `git:${source.url.toLowerCase().replace(/\.git$/i, "")}`;
}

function sameMarketplaceSource(
  a: Marketplace["source"],
  b: RecommendedMarketplace["source"],
): boolean {
  return sourceKey(a) === sourceKey(b);
}

export function MarketList({ cwd, onInstalled }: Props) {
  const { t } = useT();
  const [markets, setMarkets] = useState<Marketplace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const confirm = useConfirm();
  const alert = useAlert();
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Marketplaces currently being re-pulled (git fetch) — disables their refresh
  // button + shows a spinner so a slow clone doesn't look stuck.
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [installJobs, setInstallJobs] = useState<PluginInstallJob[]>([]);
  const [recommended, setRecommended] = useState<RecommendedMarketplaceList | null>(null);
  const [addingRecommended, setAddingRecommended] = useState<Set<string>>(new Set());
  // Marketplace install shells out to git; probe up front so we can warn before
  // the user hits a clone failure. null = not yet checked.
  const [gitCheck, setGitCheck] = useState<GitCheckResult | null>(null);

  const retry = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    window.codeshell
      .checkGit()
      .then((r) => {
        if (alive) setGitCheck(r);
      })
      .catch(() => {
        if (alive) setGitCheck(null);
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

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
    let alive = true;
    setRecommended(null);
    window.codeshell
      .listRecommendedMarketplaces()
      .then((list) => {
        if (alive) setRecommended(list);
      })
      .catch(() => {
        if (alive) setRecommended({ source: "builtin", items: [] });
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    let alive = true;
    setMarkets(null);
    setError(null);
    window.codeshell
      .listMarketplaces()
      .then((d) => {
        if (alive) setMarkets(d);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const add = async () => {
    const value = input.trim();
    if (!value) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await window.codeshell.addMarketplace(value);
      if (!res.ok) {
        setAddError(res.error ?? t("ext.market.addFailed"));
        return;
      }
      setInput("");
      retry();
    } catch (e) {
      setAddError(String((e as Error)?.message ?? e));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (name: string) => {
    const ok = await confirm({
      title: t("ext.market.removeTitle"),
      message: t("ext.market.removeConfirm", { name }),
      confirmLabel: t("ext.market.removeLabel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await window.codeshell.removeMarketplace(name);
      retry();
    } catch (e) {
      void alert({ title: t("ext.market.removeFailedTitle"), message: String((e as Error)?.message ?? e) });
    }
  };

  const refresh = async (name: string) => {
    setRefreshing((prev) => new Set(prev).add(name));
    try {
      const res = await window.codeshell.refreshMarketplace(name);
      if (!res.ok) {
        void alert({ title: t("ext.market.refreshFailedTitle"), message: res.error ?? t("ext.market.unknownError") });
        return;
      }
      retry(); // re-read the (now-updated) manifest
    } catch (e) {
      void alert({ title: t("ext.market.refreshFailedTitle"), message: String((e as Error)?.message ?? e) });
    } finally {
      setRefreshing((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const retryInstallJob = async (id: string) => {
    const res = await window.codeshell.retryPluginInstallJob(id);
    if (!res.ok) {
      void alert({ title: t("ext.market.installFailedTitle"), message: res.error ?? t("ext.market.unknownError") });
    }
  };

  const addRecommended = async (id: string) => {
    setAddingRecommended((prev) => new Set(prev).add(id));
    try {
      const res = await window.codeshell.addRecommendedMarketplace(id);
      if (!res.ok) {
        void alert({ title: t("ext.market.addFailed"), message: res.error ?? t("ext.market.unknownError") });
        return;
      }
      retry();
    } catch (e) {
      void alert({ title: t("ext.market.addFailed"), message: String((e as Error)?.message ?? e) });
    } finally {
      setAddingRecommended((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (selected !== null) {
    return (
      <MarketDetail
        cwd={cwd}
        marketName={selected}
        onBack={() => setSelected(null)}
        onInstalled={onInstalled}
      />
    );
  }

  if (error)
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        {t("ext.common.loadFailed", { error })} <Button size="sm" variant="outline" onClick={retry}>{t("ext.common.retry")}</Button>
      </div>
    );
  if (markets === null) return <div className="p-4 text-sm text-muted-foreground">{t("ext.common.loading")}</div>;

  const recommendedItems = recommended?.items ?? [];
  const isRecommendedMarket = (market: Marketplace): boolean =>
    recommendedItems.some(
      (item) => item.name === market.name || sameMarketplaceSource(market.source, item.source),
    );
  const addedRecommendedMarkets = markets.filter(isRecommendedMarket);
  const customMarkets = markets.filter((market) => !isRecommendedMarket(market));
  const availableRecommendedItems = recommendedItems.filter((item) => {
    if (!item.added) return true;
    return !markets.some(
      (market) => market.name === item.name || sameMarketplaceSource(market.source, item.source),
    );
  });

  const gitBanner =
    gitCheck?.available === false ? (
      <div className="mb-3 rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-xs text-foreground">
        <span className="font-medium">{t("ext.market.gitMissingBold")}</span> {t("ext.market.gitMissingPrefix")}
        <a
          href={gitCheck.installUrl ?? "https://git-scm.com/downloads"}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          git-scm.com
        </a>
        {t("ext.market.gitMissingSuffix")}
        <code className="rounded bg-muted px-1">git.path</code>{t("ext.market.gitMissingTail")}
      </div>
    ) : null;

  const addForm = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Input
        className="h-8 max-w-xs"
        placeholder={t("ext.market.addPlaceholder")}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          if (addError) setAddError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void add();
        }}
        disabled={adding}
      />
      <Button
        size="sm"
        disabled={adding || input.trim().length === 0}
        onClick={() => void add()}
      >
        {adding ? t("ext.market.adding") : t("ext.market.add")}
      </Button>
      {addError && <span className="text-xs text-status-err">{addError}</span>}
    </div>
  );

  const recommendedSection =
    recommended && recommended.items.length > 0 ? (
      <section className="mb-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">{t("ext.market.recommendedTitle")}</div>
            <div className="text-xs text-muted-foreground">
              {recommended.source === "remote"
                ? t("ext.market.recommendedRemote")
                : recommended.source === "cache"
                  ? t("ext.market.recommendedCache")
                  : t("ext.market.recommendedBuiltin")}
            </div>
          </div>
          {recommended.error && (
            <span className="max-w-sm truncate text-xs text-status-warn" title={recommended.error}>
              {t("ext.market.recommendedFallback")}
            </span>
          )}
        </div>
        {availableRecommendedItems.length > 0 ? (
          <ul className="space-y-1">
            {availableRecommendedItems.map((m) => {
              const isAdding = addingRecommended.has(m.id);
              return (
                <li key={m.id} className="flex items-center gap-3 rounded-lg border bg-card p-3 text-sm">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                    <Star className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 truncate">
                      <span className="truncate font-medium">{m.name}</span>
                      {m.pluginCount !== undefined && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {t("ext.market.pluginCount", { count: m.pluginCount })}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {m.reason ?? m.description ?? sourceLabel(m.source)}
                    </div>
                  </div>
                  {m.official && (
                    <Badge variant="success" className="shrink-0" title={t("ext.market.officialTip")}>
                      {t("ext.market.official")}
                    </Badge>
                  )}
                  {m.format && (
                    <Badge variant={FORMAT_BADGE[m.format].variant} className="shrink-0">
                      {m.format === "universal" ? t("ext.market.formatUniversal") : FORMAT_BADGE[m.format].label}
                    </Badge>
                  )}
                  <span className="max-w-[180px] truncate text-xs text-muted-foreground" title={sourceLabel(m.source)}>
                    {m.source.source}
                  </span>
                  <Button
                    size="sm"
                    disabled={Boolean(m.added) || isAdding}
                    onClick={() => void addRecommended(m.id)}
                  >
                    {m.added ? (
                      t("ext.market.alreadyAdded")
                    ) : isAdding ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        {t("ext.market.adding")}
                      </>
                    ) : (
                      <>
                        <PlusCircle className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("ext.market.addRecommended")}
                      </>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {t("ext.market.recommendedAllAdded")}
          </div>
        )}
      </section>
    ) : null;

  const marketRow = (m: Marketplace, opts: { recommended: boolean }) => {
    const sourcePath = sourcePathLabel(m.source);
    return (
      <li
        key={m.name}
        className="flex cursor-pointer items-center gap-3 rounded-lg border bg-card p-3 text-sm hover:bg-accent/50"
        onClick={() => setSelected(m.name)}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
          {opts.recommended ? (
            <Star className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ShoppingCart className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 truncate">
            <span className="truncate font-medium">{m.name}</span>
            {opts.recommended && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("ext.market.recommendedInstalledTag")}
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">
              {m.pluginCount >= 0 ? t("ext.market.pluginCount", { count: m.pluginCount }) : t("ext.market.manifestInvalid")}
            </span>
            <span className="shrink-0">·</span>
            <span className="truncate" title={sourceLabel(m.source)}>
              {sourcePath}
            </span>
          </div>
        </div>
        {isOfficialMarketplace(m.source) && (
          <Badge variant="success" className="shrink-0" title={t("ext.market.officialTip")}>
            {t("ext.market.official")}
          </Badge>
        )}
        {m.format && (
          <Badge variant={FORMAT_BADGE[m.format].variant} className="shrink-0">
            {m.format === "universal" ? t("ext.market.formatUniversal") : FORMAT_BADGE[m.format].label}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">{m.source.source}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="px-1 text-muted-foreground hover:text-foreground"
              title={t("ext.market.actionsTip")}
              // The row itself opens the detail on click — keep the menu
              // trigger from bubbling so opening the menu doesn't navigate.
              onClick={(e) => e.stopPropagation()}
            >
              <span className={refreshing.has(m.name) ? "inline-block animate-spin" : ""}>⋯</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem
              disabled={refreshing.has(m.name)}
              onSelect={() => void refresh(m.name)}
            >
              {t("ext.market.refreshAction")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-status-err focus:text-status-err"
              onSelect={() => void remove(m.name)}
            >
              {t("ext.market.removeAction")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-muted-foreground">›</span>
      </li>
    );
  };

  const installedSection =
    addedRecommendedMarkets.length > 0 || customMarkets.length > 0 ? (
      <div className="space-y-3">
        {addedRecommendedMarkets.length > 0 && (
          <section>
            <div className="mb-2">
              <div className="text-sm font-medium">{t("ext.market.addedRecommendedTitle")}</div>
              <div className="text-xs text-muted-foreground">
                {t("ext.market.addedRecommendedDesc")}
              </div>
            </div>
            <ul className="space-y-1">
              {addedRecommendedMarkets.map((m) => marketRow(m, { recommended: true }))}
            </ul>
          </section>
        )}

        <section>
          <div className="mb-2">
            <div className="text-sm font-medium">{t("ext.market.customTitle")}</div>
            <div className="text-xs text-muted-foreground">
              {t("ext.market.customDesc")}
            </div>
          </div>
          {customMarkets.length > 0 ? (
            <ul className="space-y-1">
              {customMarkets.map((m) => marketRow(m, { recommended: false }))}
            </ul>
          ) : (
            <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              {t("ext.market.customEmpty")}
            </div>
          )}
        </section>
      </div>
    ) : null;

  return (
    <>
      {gitBanner}
      <div className="mb-3 flex items-start justify-between gap-3">
        {addForm}
        <PluginInstallJobsPanel jobs={installJobs} onRetry={retryInstallJob} />
      </div>
      {recommendedSection}
      {markets.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">{t("ext.market.empty")}</div>
      ) : (
        installedSection
      )}
    </>
  );
}
