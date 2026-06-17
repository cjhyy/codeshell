import { useEffect, useState } from "react";
import { MarketDetail } from "./MarketDetail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useConfirm, useAlert } from "../ui/DialogProvider";
import { useT } from "../i18n/I18nProvider";

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

  if (markets.length === 0)
    return (
      <>
        {gitBanner}
        {addForm}
        <div className="p-4 text-sm text-muted-foreground">{t("ext.market.empty")}</div>
      </>
    );

  return (
    <>
      {gitBanner}
      {addForm}
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
            {m.format && (
              <Badge variant={FORMAT_BADGE[m.format].variant} className="shrink-0">
                {m.format === "universal" ? t("ext.market.formatUniversal") : FORMAT_BADGE[m.format].label}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">{m.source.source}</span>
            <button
              className="px-1 text-muted-foreground hover:text-foreground"
              title={t("ext.market.removeTip")}
              onClick={(e) => {
                e.stopPropagation();
                void remove(m.name);
              }}
            >
              ⋯
            </button>
            <span className="text-muted-foreground">›</span>
          </li>
        ))}
      </ul>
    </>
  );
}
