import { useEffect, useState } from "react";
import { MarketDetail } from "./MarketDetail";

interface Props {
  onInstalled: () => void;
}

type Marketplace = Awaited<
  ReturnType<typeof window.codeshell.listMarketplaces>
>[number];

export function MarketList({ onInstalled }: Props) {
  const [markets, setMarkets] = useState<Marketplace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [input, setInput] = useState("");
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
    if (!window.confirm(`确定移除市场 “${name}”？`)) return;
    try {
      await window.codeshell.removeMarketplace(name);
      retry();
    } catch (e) {
      window.alert(`移除失败：${String((e as Error)?.message ?? e)}`);
    }
  };

  if (selected !== null) {
    return (
      <MarketDetail
        marketName={selected}
        onBack={() => setSelected(null)}
        onInstalled={onInstalled}
      />
    );
  }

  if (error)
    return (
      <div className="customize-empty">
        加载失败：{error} <button onClick={retry}>重试</button>
      </div>
    );
  if (markets === null) return <div className="customize-empty">加载中…</div>;

  const addForm = (
    <div className="ext-add-market">
      <input
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
      <button
        className="ext-row-action"
        disabled={adding || input.trim().length === 0}
        onClick={() => void add()}
      >
        {adding ? "添加中…" : "添加"}
      </button>
      {addError && <span className="ext-add-error">{addError}</span>}
    </div>
  );

  if (markets.length === 0)
    return (
      <>
        {addForm}
        <div className="customize-empty">还没有添加任何市场</div>
      </>
    );

  return (
    <>
      {addForm}
      <ul className="ext-list">
        {markets.map((m) => (
          <li
            key={m.name}
            className="ext-row"
            onClick={() => setSelected(m.name)}
          >
            <span className="ext-row-icon">🛒</span>
            <div className="ext-row-main">
              <span className="ext-row-name">{m.name}</span>
              <span className="ext-row-desc">
                {m.pluginCount >= 0
                  ? `${m.pluginCount} 个可安装插件`
                  : "清单无效"}
              </span>
            </div>
            <span className="ext-row-source">{m.source.source}</span>
            <button
              className="ext-row-kebab"
              title="移除市场"
              onClick={(e) => {
                e.stopPropagation();
                void remove(m.name);
              }}
            >
              ⋯
            </button>
            <span className="ext-row-chevron">›</span>
          </li>
        ))}
      </ul>
    </>
  );
}
