import React, { useCallback, useRef, useState } from "react";
import { SimpleSelect } from "@/components/ui/simple-select";
import { Button } from "@/components/ui/button";
import { useExternalRuntimeModels } from "../app/useExternalRuntimeModels";
import { useT } from "../i18n/I18nProvider";
import { readScopedSettings } from "../settingsAuthority";
import { writeSettings } from "../settingsBus";
import { useRefreshOnSettingsChange } from "./useSettingsResource";
import { catalogModelOptions, type ModelInstance } from "./textConnections";
import type { ModelOption } from "../chat/ModelPill";
import {
  sessionModelKeyFromSettings,
  sessionModelSettingsPatch,
} from "../../shared/session-model-default";
import {
  isExternalRuntimeModelKey,
  normalizeExternalRuntimeModelKey,
} from "../../shared/external-runtime-models";

interface Props {
  scope: "user" | "project";
  activeProjectPath: string | null;
}

/** Explicit cross-channel default; composer selections remain session-local. */
export function SessionDefaultModelSelector({ scope, activeProjectPath }: Props) {
  const { t } = useT();
  const projectPath = scope === "project" ? (activeProjectPath ?? undefined) : undefined;
  const [snapshot, setSnapshot] = useState<{ model: string | null; models: ModelOption[] }>();
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const saving = useRef(false);
  const externalModels = useExternalRuntimeModels(true, revision);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const [settings, catalog, userSettings] = await Promise.all([
        readScopedSettings(scope, projectPath),
        window.codeshell.getModelCatalog(),
        scope === "project" ? window.codeshell.getSettings("user") : Promise.resolve(null),
      ]);
      if (request !== generation.current) return;
      const saved = sessionModelKeyFromSettings(settings);
      const connections = Array.isArray(settings?.modelConnections)
        ? settings.modelConnections
        : userSettings?.modelConnections;
      setSnapshot({
        model: saved ? normalizeExternalRuntimeModelKey(saved) : null,
        models: catalogModelOptions(
          Array.isArray(connections) ? (connections as ModelInstance[]) : [],
          catalog,
        ),
      });
      setFailed(false);
    } catch {
      if (request === generation.current) setFailed(true);
    }
  }, [scope, projectPath]);
  useRefreshOnSettingsChange(() => {
    void load();
    setRevision((value) => value + 1);
  }, [load]);
  React.useEffect(
    () => () => {
      generation.current += 1;
    },
    [load],
  );

  const models = [...(snapshot?.models ?? []), ...externalModels];
  const missing = snapshot?.model && !models.some((model) => model.key === snapshot.model);
  const save = async (model: string) => {
    if (!snapshot || saving.current) return;
    saving.current = true;
    setPending(true);
    try {
      await writeSettings(scope, sessionModelSettingsPatch(model || null), projectPath);
      await load();
    } catch {
      setFailed(true);
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return (
    // Keep SimpleSelect's absolute, visually hidden form control inside the
    // scrolling section instead of the document's initial containing block.
    <section
      className="relative rounded-xl border border-border bg-card p-4"
      data-session-default-model
    >
      <h3 className="mb-2 text-[0.95rem] font-semibold">{t("settingsX.sessionDefault.title")}</h3>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        {t(
          scope === "project"
            ? "settingsX.sessionDefault.projectDescription"
            : "settingsX.sessionDefault.description",
        )}
      </p>
      <SimpleSelect
        name="session-default-model"
        ariaLabel={t("settingsX.sessionDefault.title")}
        value={snapshot?.model ?? ""}
        disabled={!snapshot || pending}
        onChange={(model) => void save(model)}
        options={[
          {
            value: "",
            label: t(
              scope === "project"
                ? "settingsX.sessionDefault.followGlobal"
                : "settingsX.sessionDefault.followNative",
            ),
          },
          ...models.map((model) => ({
            value: model.key,
            label: isExternalRuntimeModelKey(model.key)
              ? model.label
              : `${model.provider} · ${model.label}`,
          })),
          ...(missing
            ? [
                {
                  value: snapshot.model!,
                  label: t("settingsX.sessionDefault.unavailable", { model: snapshot.model! }),
                },
              ]
            : []),
        ]}
      />
      {missing && (
        <p className="mt-2 text-xs text-status-warn" role="status">
          {t("settingsX.sessionDefault.unavailableHint")}
        </p>
      )}
      {failed && (
        <div className="mt-2 flex items-center gap-2" role="alert">
          <span className="text-xs text-status-err">{t("settingsX.sessionDefault.failed")}</span>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void load()}>
            {t("settingsX.textConn.retryRead")}
          </Button>
        </div>
      )}
    </section>
  );
}
