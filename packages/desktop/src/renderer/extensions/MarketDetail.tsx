import { useEffect, useState } from "react";

interface Props {
  cwd: string;
  marketName: string;
  onBack: () => void;
  onInstalled: () => void;
}

type Marketplace = Awaited<
  ReturnType<typeof window.codeshell.loadMarketplace>
>;

export function MarketDetail({ cwd, marketName, onBack, onInstalled }: Props) {
  const [market, setMarket] = useState<Marketplace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [installed, setInstalled] = useState<Set<string>>(new Set());

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
        // marketplace and seed them as installed.
        const here = new Set<string>();
        for (const p of plugins) {
          const at = p.installKey.lastIndexOf("@");
          if (at > 0 && p.installKey.slice(at + 1) === marketName) {
            here.add(p.installKey.slice(0, at));
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

  const install = async (pluginName: string) => {
    setBusy((prev) => new Set(prev).add(pluginName));
    try {
      const res = await window.codeshell.installPlugin(pluginName, marketName);
      if (!res.ok) {
        window.alert(`安装失败：${res.error ?? "未知错误"}`);
        return;
      }
      setInstalled((prev) => new Set(prev).add(pluginName));
      onInstalled();
    } catch (e) {
      window.alert(`安装失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(pluginName);
        return next;
      });
    }
  };

  if (error)
    return (
      <div className="customize-empty">
        加载失败：{error} <button onClick={retry}>重试</button>
      </div>
    );
  if (!loaded) return <div className="customize-empty">加载中…</div>;
  if (market === null)
    return (
      <div className="customize-empty">
        市场清单读取失败 <button onClick={retry}>重试</button>
      </div>
    );

  return (
    <>
      <div className="ext-detail-head">
        <button className="ext-back" onClick={onBack}>
          ‹ 返回
        </button>
        <span className="ext-detail-title">{market.name}</span>
      </div>
      {market.plugins.length === 0 ? (
        <div className="customize-empty">该市场没有可安装的插件</div>
      ) : (
        <ul className="ext-list">
          {market.plugins.map((p) => {
            const isBusy = busy.has(p.name);
            const isInstalled = installed.has(p.name);
            return (
              <li key={p.name} className="ext-row">
                <span className="ext-row-icon">🧩</span>
                <div className="ext-row-main">
                  <span className="ext-row-name">{p.name}</span>
                  <span className="ext-row-desc">
                    {(p.description ?? "").split("\n")[0]}
                  </span>
                </div>
                <span className="ext-row-source">
                  {p.category ?? p.author ?? ""}
                </span>
                <button
                  className="ext-row-action"
                  disabled={isBusy || isInstalled}
                  onClick={() => void install(p.name)}
                >
                  {isInstalled ? "已安装" : isBusy ? "安装中…" : "安装"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
