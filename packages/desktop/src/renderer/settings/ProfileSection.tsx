import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";

interface ProfileEntry {
  name: string;
  label: string;
  description: string | undefined;
  active: boolean;
  portableMemory: boolean;
}

/** 数字人（WorkspaceProfile）管理区块：列库、激活/切换/关闭。 */
export function ProfileSection({ cwd }: { cwd: string }) {
  const { t } = useT();
  const [profiles, setProfiles] = React.useState<ProfileEntry[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setProfiles(await window.codeshell.listProfiles(cwd));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [cwd]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t("settingsX.profiles.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("settingsX.profiles.subtitle")}</p>
      </div>
      {error ? <p className="text-xs text-status-err">{error}</p> : null}
      {profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settingsX.profiles.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {profiles.map((profile) => (
            <li
              key={profile.name}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground">{profile.label}</span>
                  {profile.active ? (
                    <Badge variant="accent">{t("settingsX.profiles.activeBadge")}</Badge>
                  ) : null}
                  {profile.portableMemory ? (
                    <Badge variant="secondary">{t("settingsX.profiles.memoryBadge")}</Badge>
                  ) : null}
                </div>
                {profile.description ? (
                  <p className="truncate text-xs text-muted-foreground">{profile.description}</p>
                ) : null}
              </div>
              {profile.active ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void act(() => window.codeshell.deactivateProfile(cwd))}
                >
                  {t("settingsX.profiles.deactivate")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() => window.codeshell.activateProfile(cwd, profile.name))
                  }
                >
                  {t("settingsX.profiles.activate")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
