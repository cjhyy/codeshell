/**
 * Manual catalog editor — an accordion of expandable cards, one per provider
 * template. Reads the merged catalog (builtin + user.json) via
 * getModelCatalog/getCatalogOrigins and writes user overrides through
 * saveCatalogEntry/deleteCatalogEntry. Card chrome mirrors connUi.tsx; controls
 * are shadcn (Button/Input/Switch/SimpleSelect). The renderer imports no core —
 * types come from preload/types and ADAPTER_KINDS from catalogEditor.
 */
import React, { useCallback, useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import type { CatalogEntry, ModelPreset, ParamSpec } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SimpleSelect } from "@/components/ui/simple-select";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
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
  activeRepoPath: string | null;
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

  const load = useCallback(async () => {
    const [c, o] = await Promise.all([
      window.codeshell.getModelCatalog().catch(() => [] as CatalogEntry[]),
      window.codeshell.getCatalogOrigins().catch(() => ({}) as Origins),
    ]);
    setEntries(c as CatalogEntry[]);
    setOrigins(o as Origins);
  }, []);

  useRefreshOnSettingsChange(() => void load(), [load]);

  const collapse = () => {
    setExpandedId(null);
    setDraft(null);
  };

  const startNew = () => {
    setDraft(blankCatalogEntry("text"));
    setExpandedId(NEW_SENTINEL);
  };

  const toggle = (entry: CatalogEntry) => {
    if (expandedId === entry.id) {
      collapse();
      return;
    }
    setDraft(structuredClone(entry));
    setExpandedId(entry.id);
  };

  const save = async () => {
    if (!draft) return;
    const errs = validateEntry(draft);
    if (errs.length > 0) {
      toast({ message: `${t("settingsX.catalog.validationFailed")}: ${errs.join("、")}`, variant: "error" });
      return;
    }
    const r = await window.codeshell.saveCatalogEntry(draft);
    if (!r.ok) {
      toast({ message: `${t("settingsX.catalog.toastSaveFailed")}: ${r.error ?? ""}`, variant: "error" });
      return;
    }
    toast({ message: t("settingsX.catalog.toastSaved"), variant: "success" });
    collapse();
    await load();
  };

  const removeOrReset = async (entry: CatalogEntry) => {
    const action = deleteAction(origins[entry.id] ?? "user");
    if (action === "none") return;
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
    if (!ok) return;
    const r = await window.codeshell.deleteCatalogEntry(entry.id);
    if (!r.ok) {
      toast({ message: `${t("settingsX.catalog.toastDeleteFailed")}: ${r.error ?? ""}`, variant: "error" });
      return;
    }
    toast({
      message: action === "reset" ? t("settingsX.catalog.toastReset") : t("settingsX.catalog.toastDeleted"),
      variant: "success",
    });
    collapse();
    await load();
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
            {t("settingsX.catalog.title")}
          </h3>
          <p className="m-0 text-xs text-muted-foreground">{t("settingsX.catalog.desc")}</p>
        </div>
        <Button onClick={startNew} disabled={expandedId === NEW_SENTINEL}>
          <Plus />
          {t("settingsX.catalog.addProvider")}
        </Button>
      </header>

      {expandedId === NEW_SENTINEL && draft && (
        <ConnCard>
          <header className="flex min-w-0 items-center gap-1.5">
            <strong className="truncate text-sm font-medium text-foreground">
              {draft.displayName || t("settingsX.catalog.newProvider")}
            </strong>
            <Badge variant="accent">{t("settingsX.catalog.originUser")}</Badge>
          </header>
          <EntryForm draft={draft} setDraft={setDraft} t={t} />
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

      {entries.length === 0 && expandedId !== NEW_SENTINEL ? (
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
                <button
                  type="button"
                  onClick={() => toggle(entry)}
                  className="flex w-full min-w-0 items-center gap-2 px-4 py-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <strong className="truncate text-sm font-medium text-foreground">
                    {entry.displayName || entry.id}
                  </strong>
                  <Badge variant="secondary">
                    {t("settingsX.catalog.models", { count: entry.modelPresets?.length ?? 0 })}
                  </Badge>
                  <Badge variant={origin === "builtin" ? "outline" : "accent"} className="ml-auto">
                    {originLabel}
                  </Badge>
                </button>

                {isOpen && draft && (
                  <div className="flex flex-col gap-2.5 border-t border-border px-4 pb-4 pt-3">
                    <EntryForm draft={draft} setDraft={setDraft} t={t} />
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
    </section>
  );
}

type TFn = ReturnType<typeof useT>["t"];

/** The base-field + models edit form, bound to `draft`. */
function EntryForm({
  draft,
  setDraft,
  t,
}: {
  draft: CatalogEntry;
  setDraft: React.Dispatch<React.SetStateAction<CatalogEntry | null>>;
  t: TFn;
}) {
  const patch = (p: Partial<CatalogEntry>) =>
    setDraft((cur) => (cur ? { ...cur, ...p } : cur));

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
          <Input value={draft.displayName} onChange={(e) => patch({ displayName: e.target.value })} />
        </ConnField>
        <ConnField label={t("settingsX.catalog.fieldId")}>
          <Input value={draft.id} onChange={(e) => patch({ id: e.target.value })} />
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
            onChange={(v) =>
              patch({ protocol: v ? (v as CatalogEntry["protocol"]) : undefined })
            }
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
      <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background/50 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">
            {t("settingsX.catalog.modelsHeading")}
          </span>
          <Button variant="ghost" size="sm" onClick={addModel}>
            <Plus />
            {t("settingsX.catalog.addModel")}
          </Button>
        </div>
        {presets.map((m, idx) => (
          <div key={idx} className="rounded-md border border-border bg-card">
            <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
              <code className="truncate font-mono text-xs text-foreground">
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
                  onClick={() => setOpenPreset(openPreset === idx ? null : idx)}
                >
                  {t("settingsX.catalog.edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-status-err"
                  onClick={() => removePreset(idx)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            {openPreset === idx && (
              <ModelPresetEditor
                preset={m}
                onChange={(p) => patchPreset(idx, p)}
                t={t}
              />
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
      <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background/50 p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">
            {t("settingsX.catalog.paramsHeading")}
          </span>
          <Button variant="ghost" size="sm" onClick={addParam}>
            <Plus />
            {t("settingsX.catalog.addParam")}
          </Button>
        </div>
        {params.map((p, idx) => (
          <div key={idx} className="flex flex-col gap-2 rounded-md border border-border bg-card p-2.5">
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
                  <Input
                    value={(p.options ?? []).join(",")}
                    onChange={(e) =>
                      patchParam(idx, {
                        options: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
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
