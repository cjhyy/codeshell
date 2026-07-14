import { useEffect, useState } from "react";
import type { PluginDetail } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Sparkles, TerminalSquare, Bot, Webhook, Plug, Puzzle, PanelTop } from "lucide-react";
import { useT } from "../i18n/I18nProvider";

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
  const { t } = useT();
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
        {t("ext.common.loadFailed", { error })}
        <Button size="sm" variant="outline" className="ml-2" onClick={onBack}>
          {t("ext.common.back")}
        </Button>
      </div>
    );
  if (!loaded)
    return <div className="p-4 text-sm text-muted-foreground">{t("ext.common.loading")}</div>;
  if (!detail)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("ext.pluginDetail.notFound")}
        <Button size="sm" variant="outline" className="ml-2" onClick={onBack}>
          {t("ext.common.back")}
        </Button>
      </div>
    );

  const { content } = detail;
  const total =
    content.skills.length +
    content.commands.length +
    content.agents.length +
    content.hooks.length +
    content.mcpServers.length +
    content.panels.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          ‹ {t("ext.common.back")}
        </button>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
          <Puzzle className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="font-semibold">{detail.name}</span>
        <span className="text-xs text-muted-foreground">
          {detail.version} · {detail.sourceLabel}
        </span>
      </div>
      {detail.description && <p className="text-xs text-muted-foreground">{detail.description}</p>}
      {total === 0 && (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">
          {t("ext.pluginDetail.empty")}
        </div>
      )}

      {content.skills.length > 0 && (
        <Section
          icon={<Sparkles className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.skillsTitle", { count: content.skills.length })}
        >
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
          title={t("ext.pluginDetail.commandsTitle", { count: content.commands.length })}
        >
          {content.commands.map((c) => (
            <li key={c} className="font-mono text-xs">
              /{c}
            </li>
          ))}
        </Section>
      )}

      {content.agents.length > 0 && (
        <Section
          icon={<Bot className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.agentsTitle", { count: content.agents.length })}
        >
          {content.agents.map((a) => (
            <li key={a} className="font-mono text-xs">
              {a}
            </li>
          ))}
        </Section>
      )}

      {content.hooks.length > 0 && (
        <Section
          icon={<Webhook className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.hooksTitle", { count: content.hooks.length })}
        >
          {content.hooks.map((h, i) => (
            <li key={`${h.rawEvent}-${i}`} className="flex items-baseline gap-2">
              <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px]">
                {h.rawEvent}
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">{h.command}</span>
            </li>
          ))}
        </Section>
      )}

      {content.mcpServers.length > 0 && (
        <Section
          icon={<Plug className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.mcpTitle", { count: content.mcpServers.length })}
        >
          {content.mcpServers.map((m) => (
            <li key={m} className="flex items-baseline gap-2">
              <span className="font-mono text-xs">{m}</span>
              <span className="text-[10px] text-muted-foreground">
                {t("ext.pluginDetail.mcpDisplayAs", { name: detail.name, server: m })}
              </span>
            </li>
          ))}
        </Section>
      )}

      {content.panels.length > 0 && (
        <Section
          icon={<PanelTop className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.panelsTitle", { count: content.panels.length })}
        >
          {content.panels.map((panel) => (
            <li key={panel.id} className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-xs">{panel.id}</span>
              <span className="truncate text-xs text-muted-foreground">
                {panel.title.default}
                {panel.permissions.length > 0
                  ? ` · ${t("ext.pluginDetail.panelPermissions", { permissions: panel.permissions.join(", ") })}`
                  : ` · ${t("ext.pluginDetail.panelNoPermissions")}`}
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
