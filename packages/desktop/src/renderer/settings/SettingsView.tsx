import React, { useEffect, useState } from "react";
import { TextConnectionsPanel } from "./TextConnectionsPanel";
import { ModelCatalogPanel } from "./ModelCatalogPanel";
import { PermissionSection } from "./PermissionSection";
import { McpSection } from "./McpSection";
import { UpdaterSettingsRow } from "../updater/UpdaterBanner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "../i18n/I18nProvider";

const segBtn = (active: boolean) =>
  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
  (active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60");

type Scope = "user" | "project";
type Tab = "model" | "catalog" | "permission" | "mcp" | "update" | "json";

interface Props {
  activeProjectPath: string | null;
}

export function SettingsView({ activeProjectPath }: Props) {
  const { t } = useT();
  const tabLabel = (tb: Tab): string => {
    switch (tb) {
      case "model":
        return t("settingsX.view.tabModel");
      case "catalog":
        return t("settingsX.view.tabCatalog");
      case "permission":
        return t("settingsX.view.tabPermission");
      case "mcp":
        return "MCP";
      case "update":
        return t("settingsX.view.tabUpdate");
      case "json":
        return "JSON";
    }
  };
  const [scope, setScope] = useState<Scope>("user");
  const [tab, setTab] = useState<Tab>("model");
  const [draft, setDraft] = useState<string>("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cwd = scope === "project" ? (activeProjectPath ?? undefined) : undefined;

  const refresh = async () => {
    setError(null);
    setLoaded(null);
    try {
      const cur = await window.codeshell.getSettings(scope, cwd);
      const text = cur ? JSON.stringify(cur, null, 2) : "{}";
      setLoaded(text);
      setDraft(text);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    if (tab === "json") void refresh();
  }, [scope, activeProjectPath, tab]);

  const dirty = draft !== loaded;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch = JSON.parse(draft) as Record<string, unknown>;
      await window.codeshell.updateSettings(scope, patch, cwd);
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
          <Button
            variant="ghost"
            size="sm"
            className={segBtn(scope === "user")}
            title={t("settingsX.view.globalTitle")}
            onClick={() => setScope("user")}
          >
            {t("settingsX.view.global")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={segBtn(scope === "project") + (!activeProjectPath ? " opacity-50" : "")}
            disabled={!activeProjectPath}
            title={
              activeProjectPath
                ? t("settingsX.view.currentProjectTitle")
                : t("settingsX.view.pickProjectFirst")
            }
            onClick={() => setScope("project")}
          >
            {t("settingsX.view.currentProject")}
          </Button>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
          {(["model", "catalog", "permission", "mcp", "update", "json"] as Tab[]).map((t) => (
            <Button
              key={t}
              variant="ghost"
              size="sm"
              className={segBtn(tab === t)}
              onClick={() => setTab(t)}
            >
              {tabLabel(t)}
            </Button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {scope === "project" && !activeProjectPath
            ? t("settingsX.view.pickAProject")
            : scope === "user"
              ? "~/.code-shell/settings.json"
              : `${activeProjectPath}/.code-shell/settings.json`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "model" && (
          <TextConnectionsPanel scope={scope} activeProjectPath={activeProjectPath} />
        )}
        {tab === "catalog" && (
          <ModelCatalogPanel scope={scope} activeProjectPath={activeProjectPath} />
        )}
        {tab === "permission" && (
          <PermissionSection scope={scope} activeProjectPath={activeProjectPath} />
        )}
        {tab === "mcp" && <McpSection scope={scope} activeProjectPath={activeProjectPath} />}
        {tab === "update" && <UpdaterSettingsRow />}
        {tab === "json" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={saving}>
                {t("settingsX.view.reload")}
              </Button>
              <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? t("settingsX.view.saving") : t("settingsX.view.save")}
              </Button>
            </div>
            {error && (
              <div className="rounded-md bg-status-err/10 p-2 text-sm text-status-err">{error}</div>
            )}
            <Textarea
              className="min-h-[400px] w-full rounded-md border border-input bg-transparent p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
