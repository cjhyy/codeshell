import { useEffect, useMemo, useState } from "react";
import { DiscoverHome } from "./DiscoverHome";
import { ManagePage, type TabKey } from "./ManagePage";
import { useT } from "../i18n/I18nProvider";
import { requireProjectConfigurationTarget } from "../configurationTarget";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  activeProjectPath: string | null;
  /**
   * When true (default), opens to the discovery home and lets the user drill
   * into the management page. When false, renders the management page directly.
   * Both the sidebar entry and Settings use the direct management page.
   */
  showDiscover?: boolean;
  /** Settings supplies its own heading, spacing, and scroll container. */
  embedded?: boolean;
}

type View = { mode: "home" } | { mode: "manage"; tab: TabKey; query?: string };

/**
 * Unified extensions surface (Codex-style). By default opens to a minimal
 * discovery home (title + search + installed overview); selecting a count or
 * submitting a search switches into the tabbed management page. With
 * showDiscover=false it renders the management page directly.
 */
export function ExtensionsPage({
  activeProjectPath,
  showDiscover = true,
  embedded = false,
}: Props) {
  const { t } = useT();
  const [noRepoCwd, setNoRepoCwd] = useState<string | null>(null);
  useEffect(() => {
    if (activeProjectPath) return;
    let alive = true;
    void window.codeshell.noRepoCwd().then((path) => {
      if (alive) setNoRepoCwd(path);
    });
    return () => {
      alive = false;
    };
  }, [activeProjectPath]);
  const cwd = activeProjectPath ?? noRepoCwd;
  const configurationTarget = useMemo(
    () =>
      activeProjectPath
        ? requireProjectConfigurationTarget(activeProjectPath)
        : ({ noRepo: true } as const),
    [activeProjectPath],
  );
  const [view, setView] = useState<View>({ mode: "home" });

  if (!cwd) {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Loader2 size={16} className="animate-spin" aria-hidden />
        {t("ext.common.loading")}
      </div>
    );
  }

  return (
    <div
      className={
        embedded ? "min-w-0" : "h-full min-w-0 overflow-y-auto bg-muted/10 px-4 py-6 sm:px-6"
      }
    >
      <div className={embedded ? "min-w-0" : "mx-auto min-w-0 max-w-5xl"}>
        {!showDiscover ? (
          <ManagePage
            cwd={cwd}
            configurationTarget={configurationTarget}
            activeProjectPath={activeProjectPath}
            showHeading={!embedded}
          />
        ) : view.mode === "home" ? (
          <DiscoverHome
            cwd={cwd}
            configurationTarget={configurationTarget}
            onOpenManage={(tab, query) => setView({ mode: "manage", tab, query })}
          />
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mb-4 gap-2 rounded-lg text-muted-foreground"
              onClick={() => setView({ mode: "home" })}
            >
              <ArrowLeft size={14} aria-hidden />
              {t("ext.common.back")}
            </Button>
            <ManagePage
              cwd={cwd}
              configurationTarget={configurationTarget}
              activeProjectPath={activeProjectPath}
              initialTab={view.tab}
              initialQuery={view.query}
              showHeading={!embedded}
            />
          </>
        )}
      </div>
    </div>
  );
}
