/** Thin shell for text/image/video/audio model connection settings. */
import React from "react";
import { Loader2, Plus } from "lucide-react";
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
  const projectPath = scope === "project" ? (activeProjectPath ?? undefined) : undefined;
  const { t } = useT();
  const heading =
    title ??
    (tag === "image"
      ? t("settingsX.textConn.headingImage")
      : tag === "video"
        ? t("settingsX.textConn.headingVideo")
        : tag === "speech"
          ? t("settingsX.textConn.headingSpeech")
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
    pending,
    loading,
    hasLoaded,
    loadFailed,
    credentialCommitRevision,
    textTemplates,
    entryById,
    load,
    addFromTemplate,
    patch,
    setConnectionKey,
    saveInstance,
    removeInstance,
    removeCredential,
    setAux,
    setDefaultInstance,
    toggleShowKey,
  } = useModelConnections(scope, projectPath, tag);

  const panelRef = React.useRef<HTMLFieldSetElement>(null);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);
  const auxSelectorRef = React.useRef<HTMLDivElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [completedFocus, setCompletedFocus] = React.useState<{ source: HTMLElement } | null>(null);
  const withFocusRestore = async (
    operation: () => Promise<void>,
    portalOpener?: HTMLElement | null,
  ) => {
    const active = document.activeElement;
    const source =
      active instanceof HTMLElement && panelRef.current?.contains(active)
        ? active
        : (portalOpener ?? null);
    try {
      await operation();
    } finally {
      if (source) setCompletedFocus({ source });
    }
  };
  const addWithFocusRestore: typeof addFromTemplate = (entry, model) =>
    withFocusRestore(() => addFromTemplate(entry, model), addButtonRef.current);

  // Automatic reads lock the same fieldset as manual retries. Preserve the
  // current control's focus when native disabling temporarily blurs it.
  useRefreshOnSettingsChange(() => void withFocusRestore(load), [load]);

  React.useLayoutEffect(() => {
    if (pending || loading || !completedFocus) return;
    setCompletedFocus(null);
    const { source } = completedFocus;
    const active = document.activeElement;
    if (active && active !== document.body && active !== source) return;
    const target =
      source.isConnected && !source.matches(":disabled")
        ? source
        : (addButtonRef.current ?? headingRef.current);
    target?.focus({ preventScroll: true });
  }, [completedFocus, pending, loading]);

  return (
    <fieldset
      ref={panelRef}
      disabled={pending || loading}
      aria-busy={pending || loading}
      aria-label={heading}
      onPointerDownCapture={(event) => {
        // Disabled fieldsets still emit pointerdown. Radix opens its portalled
        // menus on that event, beyond the fieldset's native disabled boundary.
        if (!pending && !loading) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      className="mb-6 flex min-w-0 flex-col gap-3 border-0 p-0"
    >
      {pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("settingsX.textConn.updating")}
        </p>
      ) : null}
      <header className="flex items-center justify-between">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="m-0 text-[0.95rem] font-semibold text-foreground"
        >
          {heading}
        </h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={!hasLoaded}>
            <Button ref={addButtonRef} disabled={!hasLoaded}>
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
                        onClick={() => void addWithFocusRestore(entry, p.value)}
                      >
                        {p.label ?? p.value}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : (
                <DropdownMenuItem key={entry.id} onClick={() => void addWithFocusRestore(entry)}>
                  {entry.displayName}
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {loading && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("settingsX.textConn.loading")}
        </p>
      )}
      {loadFailed && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-status-err/25 bg-status-err/5 p-3"
        >
          <p className="min-w-0 flex-1 basis-48 text-sm text-status-err">
            {t(hasLoaded ? "settingsX.textConn.refreshFailed" : "settingsX.textConn.readFailed")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void withFocusRestore(load)}
          >
            {t("settingsX.textConn.retryRead")}
          </Button>
        </div>
      )}

      {hasLoaded && tag === "text" && instances.length > 0 && (
        <div ref={auxSelectorRef}>
          <AuxModelSelector
            auxId={auxId}
            instances={instances}
            entryById={entryById}
            onSetAux={(id) =>
              withFocusRestore(
                () => setAux(id),
                auxSelectorRef.current?.querySelector<HTMLElement>('[role="combobox"]'),
              )
            }
          />
        </div>
      )}

      {!hasLoaded ? null : instances.length === 0 ? (
        <ConnectionsEmptyState
          heading={heading}
          sttFallback={sttFallback}
          textTemplates={textTemplates}
          onAddFromTemplate={addWithFocusRestore}
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
              credentialCommitRevision={credentialCommitRevision}
              isDefault={inst.id === defaultId}
              showKey={Boolean(showKey[inst.id])}
              onPatch={patch}
              onSetConnectionKey={setConnectionKey}
              onToggleShowKey={toggleShowKey}
              onSaveInstance={(id) => withFocusRestore(() => saveInstance(id))}
              onRemoveInstance={(id) => withFocusRestore(() => removeInstance(id))}
              onRemoveCredential={(id) => withFocusRestore(() => removeCredential(id))}
              onSetDefault={(id) => void withFocusRestore(() => setDefaultInstance(id))}
            />
          ))}
        </ConnCardGrid>
      )}
    </fieldset>
  );
}
