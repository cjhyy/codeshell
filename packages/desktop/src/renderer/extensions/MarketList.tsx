import { useEffect, useState } from "react";
import { MarketDetail } from "./MarketDetail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm, useAlert } from "../ui/DialogProvider";

interface Props {
  cwd: string;
  onInstalled: () => void;
}

type Marketplace = Awaited<
  ReturnType<typeof window.codeshell.listMarketplaces>
>[number];

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

  const retry = () => setReloadKey((k) => k + 1);

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
        {addForm}
        <div className="p-4 text-sm text-muted-foreground">还没有添加任何市场</div>
      </>
    );

  return (
    <>
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
