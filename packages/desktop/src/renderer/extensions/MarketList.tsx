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
import { notifySettingsChanged } from "../settingsBus";

interface Props {
  cwd: string;
  onInstalled: () => void;
}

type Marketplace = Awaited<
  ReturnType<typeof window.codeshell.listMarketplaces>
>[number];

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
  const [localBusy, setLocalBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // Marketplace install shells out to git; probe up front so we can warn before
  // the user hits a clone failure. null = not yet checked.
  const [gitOk, setGitOk] = useState<boolean | null>(null);

  const retry = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    window.codeshell
      .checkGit()
      .then((r) => {
        if (alive) setGitOk(r.available);
      })
      .catch(() => {
        if (alive) setGitOk(null);
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

  const installLocal = async (kind: "dir" | "zip") => {
    setLocalError(null);
    const picked = await window.codeshell.pickPluginSource(kind);
    if (!picked) return;
    setLocalBusy(true);
    try {
      const res = await window.codeshell.installLocalPlugin({ kind: picked.kind, path: picked.path });
      if (!res.ok) {
        setLocalError(res.error ?? t("ext.market.localInstallFailed"));
        return;
      }
      // Hot-reload hooks into running sessions; skills come via the scanner's
      // per-turn mtime key. onInstalled refreshes any installed-plugin views.
      notifySettingsChanged();
      onInstalled();
      void alert({
        title: t("ext.market.localInstalledTitle"),
        message: t("ext.market.localInstalledMsg", { name: res.name }),
      });
    } catch (e) {
      setLocalError(String((e as Error)?.message ?? e));
    } finally {
      setLocalBusy(false);
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

  const gitBanner =
    gitOk === false ? (
      <div className="mb-3 rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-xs text-foreground">
        <span className="font-medium">{t("ext.market.gitMissingBold")}</span> {t("ext.market.gitMissingPrefix")}
        <a
          href="https://git-scm.com/downloads"
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
    <div className="mb-3 flex items-center gap-2">
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

  const localInstall = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{t("ext.market.localLabel")}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={localBusy}
        onClick={() => void installLocal("dir")}
      >
        {t("ext.market.localFromDir")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={localBusy}
        onClick={() => void installLocal("zip")}
      >
        {t("ext.market.localFromZip")}
      </Button>
      {localBusy && <span className="text-xs text-muted-foreground">{t("ext.market.localInstalling")}</span>}
      {localError && <span className="text-xs text-status-err">{localError}</span>}
    </div>
  );

  if (markets.length === 0)
    return (
      <>
        {gitBanner}
        {addForm}
        {localInstall}
        <div className="p-4 text-sm text-muted-foreground">{t("ext.market.empty")}</div>
      </>
    );

  return (
    <>
      {gitBanner}
      {addForm}
      {localInstall}
      <ul className="space-y-1">
        {markets.map((m) => (
          <li
            key={m.name}
            className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm hover:bg-accent"
            onClick={() => setSelected(m.name)}
          >
            <span className="text-lg">🛒</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{m.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {m.pluginCount >= 0 ? t("ext.market.pluginCount", { count: m.pluginCount }) : t("ext.market.manifestInvalid")}
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
        ))}
      </ul>
    </>
  );
}
