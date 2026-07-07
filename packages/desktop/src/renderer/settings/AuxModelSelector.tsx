import React from "react";
import type { CatalogEntry } from "../../preload/types";
import { SimpleSelect } from "@/components/ui/simple-select";
import { useT } from "../i18n/I18nProvider";
import { ConnField } from "./connUi";
import type { ModelInstance } from "./textConnections";

export interface AuxModelSelectorProps {
  auxId: string;
  instances: ModelInstance[];
  entryById: (id: string) => CatalogEntry | undefined;
  onSetAux: (id: string) => Promise<void>;
}

export function AuxModelSelector({ auxId, instances, entryById, onSetAux }: AuxModelSelectorProps) {
  const { t } = useT();
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-[minmax(220px,320px)_1fr] sm:items-center">
      <ConnField label={t("settingsX.textConn.auxLabel")} hint={t("settingsX.textConn.auxHint")}>
        <SimpleSelect
          value={auxId}
          onChange={(v) => void onSetAux(v)}
          placeholder={t("settingsX.textConn.followCurrent")}
          options={[
            { value: "", label: t("settingsX.textConn.followCurrentDefault") },
            ...instances.map((i) => ({
              value: i.id,
              label: `${entryById(i.catalogId)?.displayName ?? i.catalogId} · ${i.model}`,
            })),
          ]}
        />
      </ConnField>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("settingsX.textConn.auxDesc")}
      </p>
    </div>
  );
}
