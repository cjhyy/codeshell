import React from "react";
import { Trash2 } from "lucide-react";
import type { CatalogEntry } from "../../preload/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/simple-select";
import { useT } from "../i18n/I18nProvider";
import { ConnCard, ConnCardFooter, ConnField, ConnFooterRight, SecretKeyInput } from "./connUi";
import { formatTok } from "./connFormat";
import { ParamControls } from "./ParamControls";
import { SignupLink } from "./SignupLink";
import {
  credentialCandidates,
  credentialLabel,
  type Credential,
  type ModelInstance,
} from "./textConnections";

export interface ConnectionInstanceCardProps {
  inst: ModelInstance;
  entry: CatalogEntry | undefined;
  catalog: CatalogEntry[];
  credentials: Credential[];
  isDefault: boolean;
  showKey: boolean;
  onPatch: (id: string, p: Partial<ModelInstance>) => void;
  onSetConnectionKey: (inst: ModelInstance, apiKey: string) => void;
  onToggleShowKey: (id: string) => void;
  onSaveInstance: (id: string) => Promise<void>;
  onRemoveInstance: (id: string) => Promise<void>;
  onRemoveCredential: (id: string) => Promise<void>;
  onSetDefault: (id: string) => void;
}

export function ConnectionInstanceCard({
  inst,
  entry,
  catalog,
  credentials,
  isDefault,
  showKey,
  onPatch,
  onSetConnectionKey,
  onToggleShowKey,
  onSaveInstance,
  onRemoveInstance,
  onRemoveCredential,
  onSetDefault,
}: ConnectionInstanceCardProps) {
  const { t } = useT();
  const preset = entry?.modelPresets?.find((p) => p.value === inst.model);
  const credChoices = credentialCandidates(credentials, inst.catalogId, catalog);
  const boundCred = credentials.find((c) => c.id === inst.credentialId);
  const displayedCredChoices =
    boundCred && !credChoices.some((credential) => credential.id === boundCred.id)
      ? [boundCred, ...credChoices]
      : credChoices;

  return (
    <ConnCard isDefault={isDefault}>
      <header className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <strong className="truncate text-sm font-medium text-foreground">
              {entry?.displayName ?? inst.catalogId}
            </strong>
            {isDefault && <Badge variant="accent">{t("settingsX.textConn.current")}</Badge>}
            {preset?.maxContextTokens && (
              <Badge variant="secondary">{formatTok(preset.maxContextTokens)} ctx</Badge>
            )}
            {preset?.maxOutputTokens && (
              <Badge variant="secondary">{formatTok(preset.maxOutputTokens)} out</Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <code className="font-mono">#{inst.id}</code>
            <span>·</span>
            <code className="break-all font-mono">{inst.model}</code>
          </div>
        </div>
        {entry?.needsKey !== false && <SignupLink url={entry?.signupUrl} />}
      </header>

      <ConnField label={t("settingsX.textConn.fieldModel")}>
        <SimpleSelect
          value={inst.model}
          onChange={(v) => onPatch(inst.id, { model: v })}
          options={(entry?.modelPresets ?? []).map((p) => ({
            value: p.value,
            label: p.label ?? p.value,
          }))}
          placeholder={inst.model || t("settingsX.textConn.pickModel")}
        />
      </ConnField>

      {entry?.needsKey !== false && (
        <>
          {(displayedCredChoices.length > 0 || boundCred) && (
            <ConnField
              label={t("settingsX.textConn.fieldCredential")}
              hint={t("settingsX.textConn.credentialHint")}
            >
              <div className="flex min-w-0 items-center gap-2">
                <SimpleSelect
                  className="min-w-0 flex-1"
                  value={inst.credentialId ?? ""}
                  onChange={(v) => onPatch(inst.id, { credentialId: v || undefined })}
                  options={[
                    ...displayedCredChoices.map((c) => ({
                      value: c.id,
                      label: credentialLabel(c, entry?.displayName),
                    })),
                    { value: "", label: t("settingsX.textConn.newKey") },
                  ]}
                  placeholder={t("settingsX.textConn.pickCredential")}
                />
                {boundCred && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted-foreground hover:text-status-err"
                    onClick={() => void onRemoveCredential(boundCred.id)}
                  >
                    <Trash2 />
                    {t("settingsX.textConn.deleteCredential")}
                  </Button>
                )}
              </div>
            </ConnField>
          )}
          {!inst.credentialId && (
            <ConnField label="API Key">
              <SecretKeyInput
                value={boundCred?.apiKey ?? ""}
                show={showKey}
                onChange={(v) => onSetConnectionKey(inst, v)}
                onToggleShow={() => onToggleShowKey(inst.id)}
              />
            </ConnField>
          )}
        </>
      )}

      {preset?.params && preset.params.length > 0 && (
        <ParamControls
          params={preset.params}
          values={inst.paramValues ?? {}}
          onChange={(name, value) =>
            onPatch(inst.id, { paramValues: { ...(inst.paramValues ?? {}), [name]: value } })
          }
        />
      )}

      <ConnCardFooter>
        <Button
          variant={isDefault ? "secondary" : "default"}
          size="sm"
          disabled={isDefault}
          onClick={() => onSetDefault(inst.id)}
        >
          {isDefault ? t("settingsX.textConn.current") : t("settingsX.textConn.setCurrent")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void onSaveInstance(inst.id)}>
          {t("settingsX.textConn.save")}
        </Button>
        <ConnFooterRight>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-status-err"
            onClick={() => void onRemoveInstance(inst.id)}
          >
            {t("settingsX.textConn.delete")}
          </Button>
        </ConnFooterRight>
      </ConnCardFooter>
    </ConnCard>
  );
}
