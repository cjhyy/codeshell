import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleSelect } from "@/components/ui/simple-select";
import { useT } from "../../i18n";
import { writeSettings } from "../../settingsBus";
import {
  PET_DELEGATED_PERMISSION_MODES,
  petDelegatedPermissionFromSettings,
  petDelegatedPermissionSettingsPatch,
  type PetDelegatedPermissionSetting,
} from "../../../shared/pet-settings";

export interface DelegatedPermissionApi {
  readUserSettings: () => Promise<unknown>;
  writeUserSettings: (patch: Record<string, unknown>) => Promise<void>;
}

const defaultApi: DelegatedPermissionApi = {
  readUserSettings: () => window.codeshell.getSettings("user"),
  writeUserSettings: (patch) => writeSettings("user", patch),
};

/** Lets a host page (or a browser fixture) supply the settings API without prop drilling. */
export const DelegatedPermissionApiContext = createContext<DelegatedPermissionApi>(defaultApi);

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Loads `pet.delegatedPermissionMode` from the user layer and saves each choice at once. */
export function useDelegatedPermissionSetting(api: DelegatedPermissionApi = defaultApi) {
  const [mode, setMode] = useState<PetDelegatedPermissionSetting | null>(null);
  const [saveError, setSaveError] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api
      .readUserSettings()
      .then((settings) => alive.current && setMode(petDelegatedPermissionFromSettings(settings)))
      // Main treats an unreadable file as the default; show the same.
      .catch(() => alive.current && setMode("inherit"));
    return () => {
      alive.current = false;
    };
  }, [api]);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const select = useCallback(
    (next: PetDelegatedPermissionSetting) => {
      const previous = modeRef.current;
      modeRef.current = next;
      setMode(next);
      setSaveError("");
      api.writeUserSettings(petDelegatedPermissionSettingsPatch(next)).catch((cause) => {
        if (!alive.current) return;
        modeRef.current = previous;
        setMode(previous);
        setSaveError(errorText(cause));
      });
    },
    [api],
  );

  return { mode, saveError, select };
}

const LABEL_KEYS = {
  inherit: "pet.settings.delegatedPermissionInherit",
  auto: "pet.settings.delegatedPermissionAuto",
  ask: "pet.settings.delegatedPermissionAsk",
} as const;

/** 派发工作的权限: which permission mode Mimi's delegated Work Sessions run with. */
export function DelegatedPermissionCard({ api }: { api?: DelegatedPermissionApi }) {
  const { t } = useT();
  const contextApi = useContext(DelegatedPermissionApiContext);
  const { mode, saveError, select } = useDelegatedPermissionSetting(api ?? contextApi);
  return (
    <Card data-pet-setting="delegated-permission" className="rounded-2xl">
      <CardHeader className="space-y-1.5">
        <CardTitle className="text-base">{t("pet.settings.delegatedPermissionTitle")}</CardTitle>
        <CardDescription className="leading-5">
          {t("pet.settings.delegatedPermissionDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="w-full max-w-sm">
          <SimpleSelect
            size="sm"
            ariaLabel={t("pet.settings.delegatedPermissionTitle")}
            value={mode ?? ""}
            disabled={mode === null}
            onChange={(value) => {
              if ((PET_DELEGATED_PERMISSION_MODES as readonly string[]).includes(value)) {
                select(value as PetDelegatedPermissionSetting);
              }
            }}
            options={PET_DELEGATED_PERMISSION_MODES.map((value) => ({
              value,
              label: t(LABEL_KEYS[value]),
            }))}
          />
        </div>
        {saveError && (
          <p role="alert" className="text-xs text-status-err [overflow-wrap:anywhere]">
            {t("pet.settings.delegatedPermissionSaveFailed", { error: saveError })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
