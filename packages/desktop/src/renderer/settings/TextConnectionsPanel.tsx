/** Thin shell for text/image/video/audio model connection settings. */
import React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "../i18n/I18nProvider";
import { AuxModelSelector } from "./AuxModelSelector";
import { ConnectionInstanceCard } from "./ConnectionInstanceCard";
import { ConnectionsEmptyState } from "./ConnectionsEmptyState";
import { ConnCardGrid } from "./connUi";
import { useModelConnections, type ConnTag } from "./useModelConnections";
import { useRefreshOnSettingsChange } from "./useSettingsResource";

interface Props {
  scope: "user" | "project";
  activeProjectPath: string | null;
  /** Which catalog tag this panel manages. Defaults to text. */
  tag?: ConnTag;
  /** Section heading. */
  title?: string;
}

export function TextConnectionsPanel({ scope, activeProjectPath, tag = "text", title }: Props) {
  const cwd = scope === "project" ? (activeProjectPath ?? undefined) : undefined;
  const { t } = useT();
  const heading =
    title ??
    (tag === "image"
      ? t("settingsX.textConn.headingImage")
      : tag === "video"
        ? t("settingsX.textConn.headingVideo")
        : tag === "audio"
          ? t("settingsX.textConn.headingAudio")
          : t("settingsX.textConn.headingText"));
  const {
    catalog,
    instances,
    credentials,
    defaultId,
    auxId,
    showKey,
    sttFallback,
    textTemplates,
    entryById,
    load,
    addFromTemplate,
    patch,
    setConnectionKey,
    saveInstance,
    removeInstance,
    setAux,
    setDefaultInstance,
    toggleShowKey,
  } = useModelConnections(scope, cwd, tag);

  // Load on mount + on scope/tag switch (deps=[load]) + auto-refresh when
  // catalog/settings change anywhere. Listeners live in one place — see
  // useRefreshOnSettingsChange.
  useRefreshOnSettingsChange(() => void load(), [load]);

  return (
    <section className="mb-6 flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">{heading}</h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>
              <Plus />
              {t("settingsX.textConn.addModel")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {textTemplates.map((entry) =>
              entry.modelPresets && entry.modelPresets.length > 0 ? (
                <DropdownMenuSub key={entry.id}>
                  <DropdownMenuSubTrigger>{entry.displayName}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {entry.modelPresets.map((p) => (
                      <DropdownMenuItem
                        key={p.value}
                        onClick={() => void addFromTemplate(entry, p.value)}
                      >
                        {p.label ?? p.value}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : (
                <DropdownMenuItem key={entry.id} onClick={() => void addFromTemplate(entry)}>
                  {entry.displayName}
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {tag === "text" && instances.length > 0 && (
        <AuxModelSelector
          auxId={auxId}
          instances={instances}
          entryById={entryById}
          onSetAux={setAux}
        />
      )}

      {instances.length === 0 ? (
        <ConnectionsEmptyState
          heading={heading}
          sttFallback={sttFallback}
          textTemplates={textTemplates}
          onAddFromTemplate={addFromTemplate}
        />
      ) : (
        <ConnCardGrid>
          {instances.map((inst) => (
            <ConnectionInstanceCard
              key={inst.id}
              inst={inst}
              entry={entryById(inst.catalogId)}
              catalog={catalog}
              credentials={credentials}
              isDefault={inst.id === defaultId}
              showKey={Boolean(showKey[inst.id])}
              onPatch={patch}
              onSetConnectionKey={setConnectionKey}
              onToggleShowKey={toggleShowKey}
              onSaveInstance={saveInstance}
              onRemoveInstance={removeInstance}
              onSetDefault={setDefaultInstance}
            />
          ))}
        </ConnCardGrid>
      )}
    </section>
  );
}
