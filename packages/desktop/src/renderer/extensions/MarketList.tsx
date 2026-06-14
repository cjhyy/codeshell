import { useEffect, useState } from "react";
import { MarketDetail } from "./MarketDetail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useConfirm, useAlert } from "../ui/DialogProvider";

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
  "claude-code": { label: "Claude Code", variant: "accent" },
  codex: { label: "Codex", variant: "info" },
  universal: { label: "通用", variant: "success" },
};

export function MarketList({ cwd, onInstalled }: Props) {
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
        setAddError(res.error ?? "添加失败");
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
      title: "移除市场",
      message: `确定移除市场 “${name}”？`,
      confirmLabel: "移除",
      destructive: true,
    });
    if (!ok) return;
    try {
      await window.codeshell.removeMarketplace(name);
      retry();
    } catch (e) {
      void alert({ title: "移除失败", message: String((e as Error)?.message ?? e) });
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
        加载失败：{error} <Button size="sm" variant="outline" onClick={retry}>重试</Button>
      </div>
    );
  if (markets === null) return <div className="p-4 text-sm text-muted-foreground">加载中…</div>;

  const gitBanner =
    gitOk === false ? (
      <div className="mb-3 rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-xs text-foreground">
        <span className="font-medium">未检测到 Git。</span> 安装/更新插件市场需要 Git。请从{" "}
        <a
          href="https://git-scm.com/downloads"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          git-scm.com
        </a>{" "}
        安装后重启;若已安装但仍提示(常见于 Windows 的 PATH 问题),可在 设置 里填写{" "}
        <code className="rounded bg-muted px-1">git.path</code> 指向 git 可执行文件。
      </div>
    ) : null;

  const addForm = (
    <div className="mb-3 flex items-center gap-2">
      <Input
        className="h-8 max-w-xs"
        placeholder="owner/repo 或 git URL"
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
        {adding ? "添加中…" : "添加"}
      </Button>
      {addError && <span className="text-xs text-status-err">{addError}</span>}
    </div>
  );

  if (markets.length === 0)
    return (
      <>
        {gitBanner}
        {addForm}
        <div className="p-4 text-sm text-muted-foreground">还没有添加任何市场</div>
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
                {m.pluginCount >= 0 ? `${m.pluginCount} 个可安装插件` : "清单无效"}
              </div>
            </div>
            {m.format && (
              <Badge variant={FORMAT_BADGE[m.format].variant} className="shrink-0">
                {FORMAT_BADGE[m.format].label}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">{m.source.source}</span>
            <button
              className="px-1 text-muted-foreground hover:text-foreground"
              title="移除市场"
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
