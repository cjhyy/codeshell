import { useState } from "react";
import { DiscoverHome } from "./DiscoverHome";
import { ManagePage, type TabKey } from "./ManagePage";
import { useT } from "../i18n/I18nProvider";

interface Props {
  activeProjectPath: string | null;
  /**
   * When true (default), opens to the discovery home and lets the user drill
   * into the management page. When false, renders the management page only —
   * used by the Settings page, which wants the bare tabbed manager with no
   * discovery home. The sidebar entry keeps the home.
   */
  showDiscover?: boolean;
}

type View = { mode: "home" } | { mode: "manage"; tab: TabKey; query?: string };

/**
 * Unified extensions surface (Codex-style). By default opens to a minimal
 * discovery home (title + search + installed overview); selecting a count or
 * submitting a search switches into the tabbed management page. With
 * showDiscover=false it renders the management page directly.
 */
export function ExtensionsPage({ activeProjectPath, showDiscover = true }: Props) {
  const { t } = useT();
  const cwd = activeProjectPath ?? "/";
  const [view, setView] = useState<View>({ mode: "home" });

  if (!showDiscover) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <ManagePage cwd={cwd} activeProjectPath={activeProjectPath} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      {view.mode === "home" ? (
        <DiscoverHome
          cwd={cwd}
          onOpenManage={(tab, query) => setView({ mode: "manage", tab, query })}
        />
      ) : (
        <>
          <button
            className="mb-3 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setView({ mode: "home" })}
          >
            ‹ {t("ext.common.back")}
          </button>
          <ManagePage
            cwd={cwd}
            activeProjectPath={activeProjectPath}
            initialTab={view.tab}
            initialQuery={view.query}
          />
        </>
      )}
    </div>
  );
}
