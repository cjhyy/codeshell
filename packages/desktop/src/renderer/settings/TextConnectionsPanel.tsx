/**
 * Unified connection panel (text / image / video by `tag`). Renders catalog
 * templates → instance cards with params driven by each model's ParamSpec[]
 * (via ParamControls). Reads/writes settings.modelConnections + credentials +
 * defaults[tag]. The engine consumes defaults[tag] (L6b), so "设为当前" here is
 * the active model. Card chrome mirrors ModelSection's look.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §5.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";

/** Compact token count, e.g. 400000 → "400K". Mirrors ModelSection. */
function formatTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
import type { CatalogEntry } from "../../preload/types";
import { writeSettings } from "../settingsBus";
import { cacheGet, cacheSet } from "./settingsCache";
import { useRefreshOnSettingsChange } from "./useSettingsResource";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SimpleSelect } from "@/components/ui/simple-select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import {
  ConnCard,
  ConnCardGrid,
  ConnCardFooter,
  ConnField,
  ConnFooterRight,
  SecretKeyInput,
} from "./connUi";
import { ParamControls } from "./ParamControls";
import {
  buildInstance,
  credentialCandidates,
  credentialLabel,
  uniqueInstanceId,
  type ModelInstance,
  type Credential,
} from "./textConnections";

type ConnTag = "text" | "image" | "video" | "audio";

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
  /** Which catalog tag this panel manages. Defaults to text. */
  tag?: ConnTag;
  /** Section heading. */
  title?: string;
}

export function TextConnectionsPanel({ scope, activeRepoPath, tag = "text", title }: Props) {
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;
  const cacheKey = `conn:${tag}:${scope}:${cwd ?? ""}`;
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
  const confirm = useConfirm();
  const toast = useToast();

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [instances, setInstances] = useState<ModelInstance[]>(
    () => cacheGet<ModelInstance[]>(cacheKey) ?? [],
  );
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [defaultId, setDefaultId] = useState<string>("");
  const [auxId, setAuxId] = useState<string>(""); // background-task model (text only)
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  // Audio only: what voice input falls back to when no audio connection is
  // configured (reused OpenAI key) — so the empty state shows the ACTIVE config
  // instead of looking unconfigured. null = not audio / nothing to fall back to.
  const [sttFallback, setSttFallback] = useState<{
    model?: string;
    maskedKey?: string;
    reusedCredentialCatalogId?: string;
  } | null>(null);

  const textTemplates = useMemo(() => catalog.filter((e) => e.tag === tag), [catalog, tag]);
  const entryById = useCallback(
    (id: string) => catalog.find((e) => e.id === id),
    [catalog],
  );

  const load = useCallback(async () => {
    const cat = (await window.codeshell.getModelCatalog().catch(() => [])) as CatalogEntry[];
    setCatalog(cat);
    const s = ((await window.codeshell.getSettings(scope, cwd)) ?? {}) as Record<string, unknown>;
    const conns = Array.isArray(s.modelConnections) ? (s.modelConnections as ModelInstance[]) : [];
    const mine = conns.filter((c) => c.tag === tag);
    setInstances(mine);
    cacheSet(cacheKey, mine);
    setCredentials(Array.isArray(s.credentials) ? (s.credentials as Credential[]) : []);
    const defaults = (s.defaults ?? {}) as Record<string, string | undefined>;
    setDefaultId(defaults[tag] ?? "");
    setAuxId(defaults.auxText ?? "");
    // Audio: surface the active fallback (reused OpenAI key) so the empty state
    // can show what voice input is actually using right now.
    if (tag === "audio") {
      try {
        const d = await window.codeshell.sttDescribe(cwd ?? "");
        setSttFallback(
          d.source === "fallback"
            ? { model: d.model, maskedKey: d.maskedKey, reusedCredentialCatalogId: d.reusedCredentialCatalogId }
            : null,
        );
      } catch {
        setSttFallback(null);
      }
    }
  }, [scope, cwd, cacheKey, tag]);

  /** Set the background-task (aux) model = a text connection id, or clear. */
  const setAux = async (id: string) => {
    setAuxId(id);
    const s = ((await window.codeshell.getSettings(scope, cwd)) ?? {}) as Record<string, unknown>;
    const defaults = (s.defaults ?? {}) as Record<string, unknown>;
    await writeSettings(scope, { defaults: { ...defaults, auxText: id || undefined } }, cwd);
    toast({
      message: id
        ? t("settingsX.textConn.toastAuxSet", { id })
        : t("settingsX.textConn.toastAuxFollow"),
      variant: "success",
    });
  };

  // Load on mount + on scope/tag switch (deps=[load]) + auto-refresh when
  // catalog/settings change anywhere. Listeners live in one place — see
  // useRefreshOnSettingsChange.
  useRefreshOnSettingsChange(() => void load(), [load]);

  const persist = useCallback(
    async (next: ModelInstance[], nextCreds: Credential[], nextDefault: string) => {
      // Merge back with other-tag connections so we don't clobber them.
      const s = ((await window.codeshell.getSettings(scope, cwd)) ?? {}) as Record<string, unknown>;
      const all = Array.isArray(s.modelConnections) ? (s.modelConnections as ModelInstance[]) : [];
      const others = all.filter((c) => c.tag !== tag);
      const defaults = (s.defaults ?? {}) as Record<string, unknown>;
      await writeSettings(
        scope,
        {
          credentials: nextCreds,
          modelConnections: [...others, ...next],
          defaults: { ...defaults, [tag]: nextDefault || undefined },
        },
        cwd,
      );
    },
    [scope, cwd, tag],
  );

  const addFromTemplate = async (entry: CatalogEntry, model?: string) => {
    const taken = new Set(instances.map((i) => i.id));
    const inst = buildInstance(entry, model, taken, tag);
    // Auto-attach to an existing credential for this provider when one exists
    // (so the user doesn't re-enter the key); else leave unset until they fill it.
    const existing = credentialCandidates(credentials, entry.id, catalog)[0];
    if (existing) inst.credentialId = existing.id;
    const next = [...instances, inst];
    const nextDefault = defaultId || inst.id;
    setInstances(next);
    setDefaultId(nextDefault);
    await persist(next, credentials, nextDefault);
    toast({ message: t("settingsX.textConn.toastAdded", { id: inst.id }), variant: "success" });
  };

  const patch = (id: string, p: Partial<ModelInstance>) =>
    setInstances((cur) => cur.map((i) => (i.id === id ? { ...i, ...p } : i)));

  /** Set this connection's key — editing (or creating) its bound credential. */
  const setConnectionKey = (inst: ModelInstance, apiKey: string) => {
    let credId = inst.credentialId;
    let nextCreds: Credential[];
    if (credId && credentials.some((c) => c.id === credId)) {
      nextCreds = credentials.map((c) => (c.id === credId ? { ...c, apiKey } : c));
    } else {
      const takenCred = new Set(credentials.map((c) => c.id));
      credId = uniqueInstanceId(`${inst.catalogId}-key`, takenCred);
      nextCreds = [...credentials, { id: credId, catalogId: inst.catalogId, apiKey }];
      patch(inst.id, { credentialId: credId });
    }
    setCredentials(nextCreds);
    return { credId, nextCreds };
  };

  const saveInstance = async (id: string) => {
    await persist(instances, credentials, defaultId || id);
    if (!defaultId) setDefaultId(id);
    toast({ message: t("settingsX.textConn.toastSaved"), variant: "success" });
  };

  const removeInstance = async (id: string) => {
    const ok = await confirm({
      message: t("settingsX.textConn.confirmRemoveMsg", { id }),
      detail: t("settingsX.textConn.confirmRemoveDetail"),
      destructive: true,
    });
    if (!ok) return;
    const next = instances.filter((i) => i.id !== id);
    const nextDefault = defaultId === id ? next[0]?.id ?? "" : defaultId;
    setInstances(next);
    setDefaultId(nextDefault);
    await persist(next, credentials, nextDefault);
    toast({ message: t("settingsX.textConn.toastRemoved", { id }), variant: "success" });
  };

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
                      <DropdownMenuItem key={p.value} onClick={() => void addFromTemplate(entry, p.value)}>
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
        <div className="grid gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-[minmax(220px,320px)_1fr] sm:items-center">
          <ConnField
            label={t("settingsX.textConn.auxLabel")}
            hint={t("settingsX.textConn.auxHint")}
          >
            <SimpleSelect
              value={auxId}
              onChange={(v) => void setAux(v)}
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
      )}

      {instances.length === 0 ? (
        // Empty state: don't just hint "click 添加模型" — surface the available
        // templates right here as quick-add cards so the user can SEE what models
        // exist (e.g. OpenAI / Groq 语音转写) and add one in a single click.
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("settingsX.textConn.emptyHint", { heading })}</p>
          {sttFallback && (
            // Audio fallback active: voice input already works by reusing an
            // OpenAI key. Render it as a real (read-only) connection CARD — not a
            // passive hint — so it sits in the list like any configured provider:
            // the user SEES the active voice provider + which key it borrows,
            // rather than an "unconfigured, go add one" impression. It carries no
            // delete/edit controls because it's implicit (adding a real audio
            // connection simply supersedes it).
            <ConnCardGrid>
              <ConnCard isDefault>
                <header className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-status-ok" />
                    <strong className="truncate text-sm font-medium text-foreground">
                      {sttFallback.reusedCredentialCatalogId ?? "OpenAI"}
                    </strong>
                    <Badge variant="accent">{t("settingsX.textConn.sttFallbackActive")}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {sttFallback.model && <code className="break-all font-mono">{sttFallback.model}</code>}
                    {sttFallback.maskedKey && (
                      <>
                        <span>·</span>
                        <code className="font-mono">key ⋯{sttFallback.maskedKey}</code>
                      </>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("settingsX.textConn.sttFallbackDesc", {
                      model: sttFallback.model ?? "",
                      cred: sttFallback.reusedCredentialCatalogId ?? "OpenAI",
                      key: sttFallback.maskedKey ?? "",
                    })}
                  </p>
                </header>
              </ConnCard>
            </ConnCardGrid>
          )}
          {textTemplates.length > 0 && (
            <ConnCardGrid>
              {textTemplates.map((entry) => (
                <ConnCard key={entry.id}>
                  <header className="flex items-start justify-between gap-2">
                    <strong className="text-sm font-medium text-foreground">{entry.displayName}</strong>
                    {entry.signupUrl && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto shrink-0 p-0 text-xs"
                        onClick={() => void window.codeshell.openExternal(entry.signupUrl!)}
                      >
                        {t("settingsX.searchConn.getKey")}
                      </Button>
                    )}
                  </header>
                  {entry.description && (
                    <p className="text-xs leading-relaxed text-muted-foreground">{entry.description}</p>
                  )}
                  {entry.defaultModel && (
                    <p className="text-xs text-muted-foreground">
                      <span className="opacity-70">{t("settingsX.textConn.defaultModelLabel")}</span>{" "}
                      <code className="rounded bg-muted px-1 py-0.5">{entry.defaultModel}</code>
                    </p>
                  )}
                  <ConnCardFooter>
                    <Button variant="solid" size="sm" onClick={() => void addFromTemplate(entry)}>
                      <Plus />
                      {t("settingsX.textConn.add")}
                    </Button>
                  </ConnCardFooter>
                </ConnCard>
              ))}
            </ConnCardGrid>
          )}
        </div>
      ) : (
        <ConnCardGrid>
          {instances.map((inst) => {
            const entry = entryById(inst.catalogId);
            const preset = entry?.modelPresets?.find((p) => p.value === inst.model);
            const credChoices = credentialCandidates(credentials, inst.catalogId, catalog);
            const boundCred = credentials.find((c) => c.id === inst.credentialId);
            const isDefault = inst.id === defaultId;
            return (
              <ConnCard key={inst.id} isDefault={isDefault}>
                <header className="flex min-w-0 flex-col gap-1">
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
                </header>

                <ConnField label={t("settingsX.textConn.fieldModel")}>
                  <SimpleSelect
                    value={inst.model}
                    onChange={(v) => patch(inst.id, { model: v })}
                    options={(entry?.modelPresets ?? []).map((p) => ({
                      value: p.value,
                      label: p.label ?? p.value,
                    }))}
                    placeholder={inst.model || t("settingsX.textConn.pickModel")}
                  />
                </ConnField>

                {entry?.needsKey !== false && (
                  <>
                    {credChoices.length > 0 && (
                      <ConnField
                        label={t("settingsX.textConn.fieldCredential")}
                        hint={t("settingsX.textConn.credentialHint")}
                      >
                        <SimpleSelect
                          value={inst.credentialId ?? ""}
                          onChange={(v) => patch(inst.id, { credentialId: v || undefined })}
                          options={[
                            ...credChoices.map((c) => ({
                              value: c.id,
                              label: credentialLabel(c, entry?.displayName),
                            })),
                            { value: "", label: t("settingsX.textConn.newKey") },
                          ]}
                          placeholder={t("settingsX.textConn.pickCredential")}
                        />
                      </ConnField>
                    )}
                    {!inst.credentialId && (
                      <ConnField label="API Key">
                        <SecretKeyInput
                          value={boundCred?.apiKey ?? ""}
                          show={Boolean(showKey[inst.id])}
                          onChange={(v) => setConnectionKey(inst, v)}
                          onToggleShow={() => setShowKey((s) => ({ ...s, [inst.id]: !s[inst.id] }))}
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
                      patch(inst.id, { paramValues: { ...(inst.paramValues ?? {}), [name]: value } })
                    }
                  />
                )}

                <ConnCardFooter>
                  <Button
                    variant={isDefault ? "secondary" : "default"}
                    size="sm"
                    disabled={isDefault}
                    onClick={() => {
                      const prevDefault = defaultId;
                      setDefaultId(inst.id); // optimistic
                      void persist(instances, credentials, inst.id).catch((e) => {
                        // Revert + surface; otherwise the UI shows the new default
                        // while disk keeps the old one (silent desync until refresh).
                        setDefaultId(prevDefault);
                        toast({
                          message: `${t("settingsX.textConn.setCurrentFailed")}: ${e instanceof Error ? e.message : String(e)}`,
                          variant: "error",
                        });
                      });
                    }}
                  >
                    {isDefault
                      ? t("settingsX.textConn.current")
                      : t("settingsX.textConn.setCurrent")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void saveInstance(inst.id)}>
                    {t("settingsX.textConn.save")}
                  </Button>
                  <ConnFooterRight>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-status-err"
                      onClick={() => void removeInstance(inst.id)}
                    >
                      {t("settingsX.textConn.delete")}
                    </Button>
                  </ConnFooterRight>
                </ConnCardFooter>
              </ConnCard>
            );
          })}
        </ConnCardGrid>
      )}
    </section>
  );
}
