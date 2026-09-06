/**
 * Manual catalog editor — an accordion of expandable cards, one per provider
 * template. Reads the merged catalog (builtin + user.json) via
 * getModelCatalog/getCatalogOrigins and writes user overrides through
 * saveCatalogEntry/deleteCatalogEntry. Card chrome mirrors connUi.tsx; controls
 * are shadcn (Button/Input/Switch/SimpleSelect). The renderer imports no core —
 * types come from preload/types and ADAPTER_KINDS from catalogEditor.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { CatalogEntry, ModelPreset, ParamSpec } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SimpleSelect } from "@/components/ui/simple-select";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";
import { useRefreshOnSettingsChange } from "./useSettingsResource";
import { ConnCard, ConnField, ConnCardFooter, ConnFooterRight } from "./connUi";
import {
  ADAPTER_KINDS,
  blankCatalogEntry,
  deleteAction,
  validateEntry,
  type CatalogEntryOrigin,
} from "./catalogEditor";

const NEW_SENTINEL = "__new_catalog_entry__";

type Origins = Record<string, CatalogEntryOrigin>;

interface Props {
  scope: "user" | "project";
  activeProjectPath: string | null;
}

/** Number-or-undefined from a text input (empty → undefined, not 0/NaN). */
function numOrUndef(raw: string): number | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function ModelCatalogPanel(_props: Props) {
  const { t } = useT();
  const confirm = useConfirm();
  const toast = useToast();

  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [origins, setOrigins] = useState<Origins>({});
  // `expandedId` is the entry id being edited, or NEW_SENTINEL for the
  // not-yet-saved "新建 provider" card. `draft` is the editing copy.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CatalogEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [readError, setReadError] = useState(false);
  const [completedRead, setCompletedRead] = useState(0);
  const [pending, setPending] = useState<"save" | "delete" | "reset" | null>(null);
  const [mutationError, setMutationError] = useState<"save" | "delete" | null>(null);
  const mounted = useRef(true);
  const readVersion = useRef(0);
  const mutationLock = useRef(false);
  const refreshRequested = useRef(false);
  const retryButton = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLFieldSetElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const completedFocus = useRef<{ source: HTMLElement; entryId?: string | null } | null>(null);

  useLayoutEffect(() => {
    if (pending || !completedFocus.current) return;
    const { source, entryId } = completedFocus.current;
    completedFocus.current = null;
    const focused = document.activeElement;
    if (focused === source || focused === document.body || focused === null) {
      const target =
        entryId === undefined
          ? source
          : entryId
            ? (triggers.current.get(entryId) ?? addButton.current)
            : addButton.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
  }, [expandedId, pending, mutationError]);

  useLayoutEffect(() => {
    if (loading || !retryFocus.current) return;
    const previous = retryFocus.current;
    retryFocus.current = null;
    const focused = document.activeElement;
    if (focused === previous || focused === document.body) {
      (readError
        ? retryButton.current
        : addButton.current?.disabled
          ? heading.current
          : addButton.current
      )?.focus({
        preventScroll: true,
      });
    }
  }, [completedRead, loading, readError]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readVersion.current++;
    };
  }, []);

  const load = useCallback(async (afterMutation = false) => {
    if (!mounted.current) return;
    if (mutationLock.current && !afterMutation) {
      refreshRequested.current = true;
      return;
    }
    refreshRequested.current = false;
    const version = ++readVersion.current;
    setLoading(true);
    try {
      // Entries and origins form one snapshot: guessing a missing origin could
      // offer deletion for a built-in template. Keep the last complete read.
      const [c, o] = await Promise.all([
        window.codeshell.getModelCatalog(),
        window.codeshell.getCatalogOrigins(),
      ]);
      if (!mounted.current || version !== readVersion.current) return;
      setEntries(c as CatalogEntry[]);
      setOrigins(o as Origins);
      setHasLoaded(true);
      setReadError(false);
    } catch {
      if (mounted.current && version === readVersion.current) setReadError(true);
    } finally {
      if (mounted.current && version === readVersion.current) {
        setLoading(false);
        setCompletedRead(version);
      }
    }
  }, []);

  useRefreshOnSettingsChange(() => void load(), [load]);

  const collapse = () => {
    const focused = document.activeElement;
    if (
      !mutationLock.current &&
      focused instanceof HTMLElement &&
      panel.current?.contains(focused)
    ) {
      completedFocus.current = {
        source: focused,
        entryId: expandedId === NEW_SENTINEL ? null : expandedId,
      };
    }
    setExpandedId(null);
    setDraft(null);
    setMutationError(null);
  };

  const startNew = () => {
    if (mutationLock.current) return;
    retryFocus.current = null;
    setMutationError(null);
    setDraft(blankCatalogEntry("text"));
    setExpandedId(NEW_SENTINEL);
  };

  const toggle = (entry: CatalogEntry) => {
    if (mutationLock.current) return;
    retryFocus.current = null;
    if (expandedId === entry.id) {
      collapse();
      return;
    }
    setMutationError(null);
    setDraft(structuredClone(entry));
    setExpandedId(entry.id);
  };

  const save = async () => {
    if (!draft || mutationLock.current) return;
    const missing = validateEntry(draft);
    if (missing.length > 0) {
      // validateEntry returns field-name tokens; map to localized labels here
      // (catalogEditor is pure / i18n-free). Separator stays locale-neutral.
      const fieldKey: Record<string, TranslationKey> = {
        id: "settingsX.catalog.fieldId",
        displayName: "settingsX.catalog.fieldDisplayName",
        defaultBaseUrl: "settingsX.catalog.fieldDefaultBaseUrl",
        adapterKind: "settingsX.catalog.fieldAdapterKind",
      };
      const labels = missing.map((f) => (fieldKey[f] ? t(fieldKey[f]) : f)).join(", ");
      toast({ message: `${t("settingsX.catalog.validationFailed")}: ${labels}`, variant: "error" });
      return;
    }
    mutationLock.current = true;
    retryFocus.current = null;
    const focused = document.activeElement;
    const focusSource =
      focused instanceof HTMLElement && panel.current?.contains(focused) ? focused : null;
    readVersion.current++;
    setLoading(false);
    setPending("save");
    setMutationError(null);
    try {
      const r = await window.codeshell.saveCatalogEntry(draft);
      if (!r.ok) throw new Error("Catalog save failed");
      if (!mounted.current) return;
      // A successful write is authoritative even if the following read fails.
      setEntries((current) =>
        current.some((entry) => entry.id === draft.id)
          ? current.map((entry) => (entry.id === draft.id ? structuredClone(draft) : entry))
          : [...current, structuredClone(draft)],
      );
      setOrigins((current) => ({
        ...current,
        [draft.id]:
          current[draft.id] === "builtin"
            ? "user-override-of-builtin"
            : (current[draft.id] ?? "user"),
      }));
      if (focusSource) completedFocus.current = { source: focusSource, entryId: draft.id };
      collapse();
      toast({ message: t("settingsX.catalog.toastSaved"), variant: "success" });
      await load(true);
    } catch {
      if (mounted.current) {
        if (focusSource) completedFocus.current = { source: focusSource };
        setMutationError("save");
      }
    } finally {
      mutationLock.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const removeOrReset = async (entry: CatalogEntry) => {
    if (mutationLock.current) return;
    const action = deleteAction(origins[entry.id] ?? "user");
    if (action === "none") return;
    mutationLock.current = true;
    refreshRequested.current ||= loading;
    retryFocus.current = null;
    const focused = document.activeElement;
    const focusSource =
      focused instanceof HTMLElement && panel.current?.contains(focused) ? focused : null;
    readVersion.current++;
    setLoading(false);
    let didMutate = false;
    try {
      const ok = await confirm({
        message:
          action === "reset"
            ? t("settingsX.catalog.confirmResetMsg")
            : t("settingsX.catalog.confirmDeleteMsg"),
        detail:
          action === "reset"
            ? t("settingsX.catalog.confirmResetDetail")
            : t("settingsX.catalog.confirmDeleteDetail"),
        destructive: true,
      });
      if (!ok || !mounted.current) return;
      didMutate = true;
      setPending(action);
      setMutationError(null);
      const r = await window.codeshell.deleteCatalogEntry(entry.id);
      if (!r.ok) throw new Error("Catalog removal failed");
      if (!mounted.current) return;
      if (action === "delete")
        setEntries((current) => current.filter((item) => item.id !== entry.id));
      if (focusSource)
        completedFocus.current = {
          source: focusSource,
          entryId: action === "delete" ? null : entry.id,
        };
      collapse();
      toast({
        message:
          action === "reset"
            ? t("settingsX.catalog.toastReset")
            : t("settingsX.catalog.toastDeleted"),
        variant: "success",
      });
      await load(true);
    } catch {
      if (mounted.current) {
        if (focusSource) completedFocus.current = { source: focusSource };
        setMutationError("delete");
      }
    } finally {
      mutationLock.current = false;
      if (mounted.current) setPending(null);
      if (!didMutate && refreshRequested.current) void load();
    }
  };

  const mutationNotice = mutationError ? (
    <p
      role="alert"
      className="rounded-lg border border-status-err/25 bg-status-err/5 px-3 py-2 text-sm text-status-err"
    >
      {t(
        mutationError === "save"
          ? "settingsX.catalog.toastSaveFailed"
          : "settingsX.catalog.toastDeleteFailed",
      )}
    </p>
  ) : null;

  return (
    <fieldset
      ref={panel}
      disabled={pending !== null}
      aria-busy={pending !== null || loading}
      aria-label={t("settingsX.catalog.title")}
      onPointerDownCapture={(event) => {
        if (!pending) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      className="mb-6 flex min-w-0 flex-col gap-3 border-0 p-0"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          <h3
            ref={heading}
            tabIndex={-1}
            className="m-0 text-[0.95rem] font-semibold text-foreground"
          >
            {t("settingsX.catalog.title")}
          </h3>
          <p className="m-0 text-xs leading-relaxed text-muted-foreground">
            {t("settingsX.catalog.desc")}
          </p>
        </div>
        <Button
          ref={addButton}
          className="shrink-0"
          onClick={startNew}
          disabled={!hasLoaded || expandedId === NEW_SENTINEL}
        >
          <Plus />
          {t("settingsX.catalog.addProvider")}
        </Button>
      </header>

      {pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("settingsX.catalog.updating")}
        </p>
      ) : loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("settingsX.catalog.loading")}
        </p>
      ) : null}
      {readError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-status-err/25 bg-status-err/5 p-3"
        >
          <p className="min-w-0 flex-1 basis-56 text-sm text-status-err">
            {t(hasLoaded ? "settingsX.catalog.refreshFailed" : "settingsX.catalog.readFailed")}
          </p>
          <Button
            ref={retryButton}
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => {
              retryFocus.current =
                document.activeElement === retryButton.current ? retryButton.current : null;
              void load();
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {t("settingsX.catalog.retry")}
          </Button>
        </div>
      )}

      {expandedId === NEW_SENTINEL && draft && (
        <ConnCard>
          <header className="flex min-w-0 items-center gap-1.5">
            <strong className="truncate text-sm font-medium text-foreground">
              {draft.displayName || t("settingsX.catalog.newProvider")}
            </strong>
            <Badge variant="accent">{t("settingsX.catalog.originUser")}</Badge>
          </header>
          <EntryForm draft={draft} setDraft={setDraft} t={t} idLocked={false} />
          {mutationNotice}
          <ConnCardFooter>
            <Button size="sm" onClick={() => void save()}>
              {t("settingsX.catalog.save")}
            </Button>
            <Button variant="ghost" size="sm" onClick={collapse}>
              {t("settingsX.catalog.cancel")}
            </Button>
          </ConnCardFooter>
        </ConnCard>
      )}

      {hasLoaded &&
      !loading &&
      !readError &&
      entries.length === 0 &&
      expandedId !== NEW_SENTINEL ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          {t("settingsX.catalog.empty")}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((entry) => {
            const isOpen = expandedId === entry.id;
            const origin = origins[entry.id] ?? "user";
            const action = deleteAction(origin);
            const originLabel =
              origin === "builtin"
                ? t("settingsX.catalog.originBuiltin")
                : origin === "user-override-of-builtin"
                  ? t("settingsX.catalog.originOverride")
                  : t("settingsX.catalog.originUser");
            return (
              <ConnCard key={entry.id} className="gap-0 p-0">
                <Button
                  ref={(node) => {
                    if (node) triggers.current.set(entry.id, node);
                    else triggers.current.delete(entry.id);
                  }}
                  type="button"
                  variant="ghost"
                  onClick={() => toggle(entry)}
                  aria-expanded={isOpen}
                  className="h-auto w-full min-w-0 flex-wrap justify-start gap-2 rounded-none px-4 py-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <strong className="min-w-0 flex-1 basis-32 whitespace-normal break-words text-sm font-medium text-foreground">
                    {entry.displayName || entry.id}
                  </strong>
                  <Badge variant="secondary">
                    {t("settingsX.catalog.models", { count: entry.modelPresets?.length ?? 0 })}
                  </Badge>
                  <Badge variant={origin === "builtin" ? "outline" : "accent"} className="ml-auto">
                    {originLabel}
                  </Badge>
                </Button>

                {isOpen && draft && (
                  <div className="flex flex-col gap-2.5 border-t border-border px-4 pb-4 pt-3">
                    <EntryForm draft={draft} setDraft={setDraft} t={t} idLocked />
                    {mutationNotice}
                    <ConnCardFooter>
                      <Button size="sm" onClick={() => void save()}>
                        {t("settingsX.catalog.save")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={collapse}>
                        {t("settingsX.catalog.cancel")}
                      </Button>
                      {action !== "none" && (
                        <ConnFooterRight>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-status-err"
                            onClick={() => void removeOrReset(entry)}
                          >
                            {action === "reset"
                              ? t("settingsX.catalog.reset")
                              : t("settingsX.catalog.delete")}
                          </Button>
                        </ConnFooterRight>
                      )}
                    </ConnCardFooter>
                  </div>
                )}
              </ConnCard>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

type TFn = ReturnType<typeof useT>["t"];

/** Keep punctuation while typing; the catalog receives normalized options. */
function EnumOptionsInput({
  options,
  onChange,
}: {
  options: string[] | undefined;
  onChange: (options: string[]) => void;
}) {
  const [draft, setDraft] = useState<{ text: string; options: string[] } | null>(null);
  return (
    <Input
      value={draft && draft.options === options ? draft.text : (options ?? []).join(",")}
      onChange={(event) => {
        const text = event.target.value;
        const next = text
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        setDraft({ text, options: next });
        onChange(next);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/** The base-field + models edit form, bound to `draft`. */
function EntryForm({
  draft,
  setDraft,
  t,
  idLocked,
}: {
  draft: CatalogEntry;
  setDraft: React.Dispatch<React.SetStateAction<CatalogEntry | null>>;
  t: TFn;
  /**
   * When true (editing an EXISTING entry), the id field is read-only. The id is
   * the catalog key: changing it then saving would fork a duplicate (save keys
   * by draft.id) rather than rename, and changing it then deleting would target
   * the wrong/original id. To rename, delete + re-create. Only the new-entry
   * card lets you choose the id.
   */
  idLocked: boolean;
}) {
  const patch = (p: Partial<CatalogEntry>) => setDraft((cur) => (cur ? { ...cur, ...p } : cur));

  const patchPresets = (presets: ModelPreset[]) => patch({ modelPresets: presets });

  const presets = draft.modelPresets ?? [];
  const [openPreset, setOpenPreset] = useState<number | null>(null);

  const addModel = () => {
    const next = [...presets, { value: "" } as ModelPreset];
    patchPresets(next);
    setOpenPreset(next.length - 1);
  };

  const patchPreset = (idx: number, p: Partial<ModelPreset>) =>
    patchPresets(presets.map((m, i) => (i === idx ? { ...m, ...p } : m)));

  const removePreset = (idx: number) => {
    patchPresets(presets.filter((_, i) => i !== idx));
    setOpenPreset(null);
  };

  return (
    <>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <ConnField label={t("settingsX.catalog.fieldDisplayName")}>
          <Input
            value={draft.displayName}
            onChange={(e) => patch({ displayName: e.target.value })}
          />
        </ConnField>
        <ConnField label={t("settingsX.catalog.fieldId")}>
          <Input
            value={draft.id}
            onChange={(e) => patch({ id: e.target.value })}
            disabled={idLocked}
          />
        </ConnField>
      </div>
      <ConnField label={t("settingsX.catalog.fieldDescription")}>
        <Input value={draft.description} onChange={(e) => patch({ description: e.target.value })} />
      </ConnField>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <ConnField label={t("settingsX.catalog.fieldTag")}>
          <SimpleSelect
            value={draft.tag}
            onChange={(v) => patch({ tag: v as CatalogEntry["tag"] })}
            options={[
              { value: "text", label: "text" },
              { value: "image", label: "image" },
              { value: "video", label: "video" },
              { value: "audio", label: "audio" },
            ]}
          />
        </ConnField>
        <ConnField label={t("settingsX.catalog.fieldAdapterKind")}>
          <SimpleSelect
            value={draft.adapterKind}
            onChange={(v) => patch({ adapterKind: v })}
            options={ADAPTER_KINDS.map((k) => ({ value: k, label: k }))}
          />
        </ConnField>
        <ConnField label={t("settingsX.catalog.fieldProtocol")}>
          <SimpleSelect
            value={draft.protocol ?? ""}
            onChange={(v) => patch({ protocol: v ? (v as CatalogEntry["protocol"]) : undefined })}
            placeholder={t("settingsX.catalog.protocolNone")}
            options={[
              { value: "", label: t("settingsX.catalog.protocolNone") },
              { value: "openai-compat", label: "openai-compat" },
              { value: "anthropic-style", label: "anthropic-style" },
            ]}
          />
        </ConnField>
        <ConnField label={t("settingsX.catalog.fieldDefaultModel")}>
          <Input
            value={draft.defaultModel ?? ""}
            onChange={(e) => patch({ defaultModel: e.target.value || undefined })}
          />
        </ConnField>
      </div>
      <ConnField label={t("settingsX.catalog.fieldDefaultBaseUrl")}>
        <Input
          value={draft.defaultBaseUrl}
          onChange={(e) => patch({ defaultBaseUrl: e.target.value })}
          className="font-mono"
        />
      </ConnField>
      <ConnField label={t("settingsX.catalog.fieldSignupUrl")}>
        <Input
          value={draft.signupUrl ?? ""}
          onChange={(e) => patch({ signupUrl: e.target.value || undefined })}
          className="font-mono"
        />
      </ConnField>
      <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Switch
          checked={draft.needsKey !== false}
          onCheckedChange={(c) => patch({ needsKey: c })}
        />
        {t("settingsX.catalog.fieldNeedsKey")}
      </label>

      {/* MODELS sub-list */}
      <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-foreground">
            {t("settingsX.catalog.modelsHeading")}
          </h4>
          <Button variant="ghost" size="sm" onClick={addModel}>
            <Plus />
            {t("settingsX.catalog.addModel")}
          </Button>
        </div>
        {presets.map((m, idx) => (
          <div key={idx} className="min-w-0 rounded-lg border border-border bg-card">
            <div className="flex min-w-0 flex-wrap items-center gap-2 px-2.5 py-2">
              <code className="min-w-0 flex-1 basis-28 break-all font-mono text-xs text-foreground">
                {m.value || "—"}
              </code>
              {m.maxContextTokens != null && (
                <Badge variant="secondary">
                  {t("settingsX.catalog.ctx", { n: m.maxContextTokens })}
                </Badge>
              )}
              <Badge variant="outline">
                {t("settingsX.catalog.params", { count: m.params?.length ?? 0 })}
              </Badge>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={openPreset === idx}
                  onClick={() => setOpenPreset(openPreset === idx ? null : idx)}
                >
                  {t("settingsX.catalog.edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-status-err"
                  aria-label={t("settingsX.catalog.deleteModel", { model: m.value || "—" })}
                  onClick={() => removePreset(idx)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            {openPreset === idx && (
              <ModelPresetEditor preset={m} onChange={(p) => patchPreset(idx, p)} t={t} />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** Inline editor for one ModelPreset, including its params list. */
function ModelPresetEditor({
  preset,
  onChange,
  t,
}: {
  preset: ModelPreset;
  onChange: (p: Partial<ModelPreset>) => void;
  t: TFn;
}) {
  const params = preset.params ?? [];

  const patchParams = (next: ParamSpec[]) => onChange({ params: next });
  const addParam = () => patchParams([...params, { name: "", control: "text" }]);
  const patchParam = (idx: number, p: Partial<ParamSpec>) =>
    patchParams(params.map((x, i) => (i === idx ? { ...x, ...p } : x)));
  const removeParam = (idx: number) => patchParams(params.filter((_, i) => i !== idx));

  return (
    <div className="flex flex-col gap-2.5 border-t border-border px-3 py-3">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <ConnField label={t("settingsX.catalog.modelValue")}>
          <Input
            value={preset.value}
            onChange={(e) => onChange({ value: e.target.value })}
            className="font-mono"
          />
        </ConnField>
        <ConnField label={t("settingsX.catalog.modelLabel")}>
          <Input
            value={preset.label ?? ""}
            onChange={(e) => onChange({ label: e.target.value || undefined })}
          />
        </ConnField>
        <ConnField label={t("settingsX.catalog.modelMaxContext")}>
          <Input
            type="number"
            value={preset.maxContextTokens ?? ""}
            onChange={(e) => onChange({ maxContextTokens: numOrUndef(e.target.value) })}
          />
        </ConnField>
        <ConnField label={t("settingsX.catalog.modelMaxOutput")}>
          <Input
            type="number"
            value={preset.maxOutputTokens ?? ""}
            onChange={(e) => onChange({ maxOutputTokens: numOrUndef(e.target.value) })}
          />
        </ConnField>
      </div>
      <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Switch
          checked={Boolean(preset.supportsVision)}
          onCheckedChange={(c) => onChange({ supportsVision: c })}
        />
        {t("settingsX.catalog.modelSupportsVision")}
      </label>

      {/* PARAMS editor (MVP: name/control/options/default/wire.field; min/max/doc omitted) */}
      <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/20 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 className="text-xs font-semibold text-foreground">
            {t("settingsX.catalog.paramsHeading")}
          </h5>
          <Button variant="ghost" size="sm" onClick={addParam}>
            <Plus />
            {t("settingsX.catalog.addParam")}
          </Button>
        </div>
        {params.map((p, idx) => (
          <div
            key={idx}
            className="flex flex-col gap-2 rounded-md border border-border bg-card p-2.5"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <ConnField label={t("settingsX.catalog.paramName")}>
                <Input value={p.name} onChange={(e) => patchParam(idx, { name: e.target.value })} />
              </ConnField>
              <ConnField label={t("settingsX.catalog.paramControl")}>
                <SimpleSelect
                  value={p.control}
                  onChange={(v) => patchParam(idx, { control: v as ParamSpec["control"] })}
                  options={[
                    { value: "enum", label: "enum" },
                    { value: "number", label: "number" },
                    { value: "toggle", label: "toggle" },
                    { value: "text", label: "text" },
                  ]}
                />
              </ConnField>
              {p.control === "enum" && (
                <ConnField label={t("settingsX.catalog.paramOptions")}>
                  <EnumOptionsInput
                    options={p.options}
                    onChange={(options) => patchParam(idx, { options })}
                  />
                </ConnField>
              )}
              <ConnField label={t("settingsX.catalog.paramDefault")}>
                <Input
                  value={p.default == null ? "" : String(p.default)}
                  onChange={(e) => patchParam(idx, { default: e.target.value || undefined })}
                />
              </ConnField>
              <ConnField label={t("settingsX.catalog.paramWireField")}>
                <Input
                  value={p.wire?.field ?? ""}
                  onChange={(e) =>
                    patchParam(idx, {
                      wire: e.target.value ? { field: e.target.value } : undefined,
                    })
                  }
                  className="font-mono"
                />
              </ConnField>
            </div>
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-status-err"
                onClick={() => removeParam(idx)}
              >
                <Trash2 />
                {t("settingsX.catalog.delete")}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
