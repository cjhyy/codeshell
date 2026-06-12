import { useEffect, useState } from "react";
import type { PluginDetail } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Sparkles, TerminalSquare, Bot, Webhook, Plug } from "lucide-react";

/**
 * Plugin detail (feedback#15: 插件列表只显 "N skills",看不到里面有啥) —
 * read-only inventory of everything one plugin contributes: skills /
 * commands / agents / hooks / MCP servers. Same list→detail pattern as
 * MarketList→MarketDetail.
 */
export function PluginDetailView({
  installKey,
  onBack,
}: {
  installKey: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setError(null);
    window.codeshell
      .getPluginDetail(installKey)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setLoaded(true);
      })
      .catch((e) => {
        if (alive) setError(String((e as Error)?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [installKey]);

  if (error)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        加载失败：{error}
        <Button size="sm" variant="outline" className="ml-2" onClick={onBack}>
          返回
        </Button>
      </div>
    );
  if (!loaded) return <div className="p-4 text-sm text-muted-foreground">加载中…</div>;
  if (!detail)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        找不到该插件（可能已被卸载）。
        <Button size="sm" variant="outline" className="ml-2" onClick={onBack}>
          返回
        </Button>
      </div>
    );

  const { content } = detail;
  const total =
    content.skills.length +
    content.commands.length +
    content.agents.length +
    content.hooks.length +
    content.mcpServers.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          ‹ 返回
        </button>
        <span className="text-lg">🧩</span>
        <span className="font-semibold">{detail.name}</span>
        <span className="text-xs text-muted-foreground">
          {detail.version} · {detail.sourceLabel}
        </span>
      </div>
      {detail.description && (
        <p className="text-xs text-muted-foreground">{detail.description}</p>
      )}
      {total === 0 && (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">
          这个插件没有可枚举的内容（skills / commands / agents / hooks / MCP 均为空）。
        </div>
      )}

      {content.skills.length > 0 && (
        <Section icon={<Sparkles className="h-3.5 w-3.5" />} title={`Skills（${content.skills.length}）`}>
          {content.skills.map((s) => (
            <li key={s.name} className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-xs">{s.name}</span>
              {s.description && (
                <span className="truncate text-xs text-muted-foreground">{s.description}</span>
              )}
            </li>
          ))}
        </Section>
      )}

      {content.commands.length > 0 && (
        <Section
          icon={<TerminalSquare className="h-3.5 w-3.5" />}
          title={`Commands（${content.commands.length}）`}
        >
          {content.commands.map((c) => (
            <li key={c} className="font-mono text-xs">/{c}</li>
          ))}
        </Section>
      )}

      {content.agents.length > 0 && (
        <Section icon={<Bot className="h-3.5 w-3.5" />} title={`Agents（${content.agents.length}）`}>
          {content.agents.map((a) => (
            <li key={a} className="font-mono text-xs">{a}</li>
          ))}
        </Section>
      )}

      {content.hooks.length > 0 && (
        <Section icon={<Webhook className="h-3.5 w-3.5" />} title={`Hooks（${content.hooks.length}）`}>
          {content.hooks.map((h, i) => (
            <li key={`${h.rawEvent}-${i}`} className="flex items-baseline gap-2">
              <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px]">{h.rawEvent}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{h.command}</span>
            </li>
          ))}
        </Section>
      )}

      {content.mcpServers.length > 0 && (
        <Section icon={<Plug className="h-3.5 w-3.5" />} title={`MCP servers（${content.mcpServers.length}）`}>
          {content.mcpServers.map((m) => (
            <li key={m} className="flex items-baseline gap-2">
              <span className="font-mono text-xs">{m}</span>
              <span className="text-[10px] text-muted-foreground">
                在 MCP 设置页显示为 {detail.name}:{m}
              </span>
            </li>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {title}
      </div>
      <ul className="space-y-1">{children}</ul>
    </section>
  );
}
