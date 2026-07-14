import { useEffect, useState } from "react";
import { PanelTop } from "lucide-react";
import type { PluginPanelExtensionSummary } from "../../shared/plugin-panels";
import { Badge } from "@/components/ui/badge";
import { useT } from "../i18n/I18nProvider";

interface Props {
  cwd: string;
  query: string;
}

/** Installed UI panel contributions. Packages and agent contributions remain separate tabs. */
export function PanelsTab({ cwd, query }: Props) {
  const { t, lang } = useT();
  const [panels, setPanels] = useState<PluginPanelExtensionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPanels(null);
    setError(null);
    window.codeshell
      .listPanelExtensions(cwd, lang)
      .then((next) => {
        if (alive) setPanels(next);
      })
      .catch((cause) => {
        if (!alive) return;
        setPanels([]);
        setError(String((cause as Error)?.message ?? cause));
      });
    return () => {
      alive = false;
    };
  }, [cwd, lang]);

  if (error) {
    return <div className="p-4 text-sm text-status-err">{t("ext.common.loadFailed", { error })}</div>;
  }
  if (panels === null) {
    return <div className="p-4 text-sm text-muted-foreground">{t("ext.common.loading")}</div>;
  }

  const needle = query.trim().toLowerCase();
  const rows = needle
    ? panels.filter((panel) =>
        [panel.title, panel.pluginName, panel.panelId, ...panel.permissions].some((value) =>
          value.toLowerCase().includes(needle),
        ),
      )
    : panels;

  if (panels.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">{t("ext.panels.empty")}</div>;
  }
  if (rows.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">{t("ext.panels.noMatch")}</div>;
  }

  return (
    <ul className="space-y-2">
      {rows.map((panel) => (
        <li key={panel.id} className="flex items-start gap-3 rounded-lg border bg-card p-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
            <PanelTop className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{panel.title}</span>
              <Badge variant={panel.enabled ? "success" : "secondary"}>
                {panel.enabled ? t("ext.panels.enabled") : t("ext.panels.disabled")}
              </Badge>
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {t("ext.panels.owner", { plugin: panel.pluginName, panel: panel.panelId })}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {panel.permissions.length === 0 ? (
                <Badge variant="outline">{t("ext.panels.noPermissions")}</Badge>
              ) : (
                panel.permissions.map((permission) => (
                  <Badge key={permission} variant="outline">
                    {permission}
                  </Badge>
                ))
              )}
              {panel.singleton && <Badge variant="outline">{t("ext.panels.singleton")}</Badge>}
            </div>
            {panel.disabledByPackage && (
              <div className="mt-2 text-xs text-muted-foreground">
                {t("ext.panels.disabledByPackage")}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
