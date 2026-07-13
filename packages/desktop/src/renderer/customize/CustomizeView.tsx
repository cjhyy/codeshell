import React from "react";
import { ExtensionsPage } from "../extensions/ExtensionsPage";
import { useT } from "../i18n/I18nProvider";

interface Props {
  activeProjectPath: string | null;
}

/**
 * Full-screen "扩展" view, reached from the sidebar-top entry.
 *
 * Hosts the same Codex-style ExtensionsPage that also lives under
 * Settings → 扩展, so there is a single source of truth for
 * plugin/skill/MCP management — this is just a second door to it.
 */
export function CustomizeView({ activeProjectPath }: Props) {
  const { t } = useT();
  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <header className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-foreground">{t("auto.customize.title")}</h2>
      </header>
      <ExtensionsPage activeProjectPath={activeProjectPath} />
    </div>
  );
}
