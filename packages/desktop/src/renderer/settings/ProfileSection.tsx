import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { useProfileSwitch } from "../digital-humans/useProfileSwitch";
import { ProfileSwitchDialog } from "../digital-humans/ProfileSwitchDialog";
import { useDigitalHumanContext } from "../digital-humans/useDigitalHumansLibrary";
import type { RendererConfigurationTarget } from "../../preload/types";

interface ProfileEntry {
  name: string;
  label: string;
  description: string | undefined;
  active: boolean;
  portableMemory: boolean;
}

/** 数字人（WorkspaceProfile）管理区块：列库、激活/切换/关闭。 */
export function ProfileSection({
  configurationTarget,
}: {
  configurationTarget: RendererConfigurationTarget;
}) {
  const { t } = useT();
  const captureContext = useDigitalHumanContext(configurationTarget);
  const [profiles, setProfiles] = React.useState<ProfileEntry[]>([]);
  const targetKey = JSON.stringify(configurationTarget);
  const [loadedTargetKey, setLoadedTargetKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const refresh = React.useCallback(async () => {
    const isCurrent = captureContext();
    try {
      const profiles = await window.codeshell.listProfiles(configurationTarget);
      if (!isCurrent()) return;
      setProfiles(profiles);
      setLoadedTargetKey(targetKey);
      setError(null);
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [configurationTarget, captureContext, targetKey]);
  const profileSwitch = useProfileSwitch(configurationTarget, refresh);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t("settingsX.profiles.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("settingsX.profiles.subtitle")}</p>
      </div>
      {error ? <p className="text-xs text-status-err">{error}</p> : null}
      {profiles.length === 0 || loadedTargetKey !== targetKey ? (
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
                  disabled={profileSwitch.busy}
                  onClick={() => void profileSwitch.open(null)}
                >
                  {t("settingsX.profiles.deactivate")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={profileSwitch.busy}
                  onClick={() => void profileSwitch.open(profile.name)}
                >
                  {t("settingsX.profiles.activate")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ProfileSwitchDialog controller={profileSwitch} />
    </section>
  );
}
