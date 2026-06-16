/**
 * Unified connection panel (text / image / video by `tag`). Renders catalog
 * templates → instance cards with params driven by each model's ParamSpec[]
 * (via ParamControls). Reads/writes settings.modelConnections + credentials +
 * defaults[tag]. The engine consumes defaults[tag] (L6b), so "设为当前" here is
 * the active model. Card chrome mirrors ModelSection's look.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §5.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
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

type ConnTag = "text" | "image" | "video";

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
  const heading = title ?? (tag === "image" ? "图片模型" : tag === "video" ? "视频模型" : "文本模型");
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
  }, [scope, cwd, cacheKey, tag]);

  /** Set the background-task (aux) model = a text connection id, or clear. */
  const setAux = async (id: string) => {
    setAuxId(id);
    const s = ((await window.codeshell.getSettings(scope, cwd)) ?? {}) as Record<string, unknown>;
    const defaults = (s.defaults ?? {}) as Record<string, unknown>;
    await writeSettings(scope, { defaults: { ...defaults, auxText: id || undefined } }, cwd);
    toast({ message: id ? `后台任务模型已设为 ${id}` : "后台任务模型已跟随当前模型", variant: "success" });
  };

  useEffect(() => {
    void load();
    // Live refresh: the EditModelCatalog tool (or a manual settings edit) writes
    // the catalog/settings from the worker process; App dispatches these events
    // on turn_complete / settings save, so the panel re-pulls catalog +
    // connections without a restart.
    const reload = () => void load();
    window.addEventListener("codeshell:files-changed", reload);
    window.addEventListener("codeshell:settings-changed", reload);
    return () => {
      window.removeEventListener("codeshell:files-changed", reload);
      window.removeEventListener("codeshell:settings-changed", reload);
    };
  }, [load]);

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
    const existing = credentialCandidates(credentials, entry.id)[0];
    if (existing) inst.credentialId = existing.id;
    const next = [...instances, inst];
    const nextDefault = defaultId || inst.id;
    setInstances(next);
    setDefaultId(nextDefault);
    await persist(next, credentials, nextDefault);
    toast({ message: `已添加 ${inst.id}`, variant: "success" });
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
    toast({ message: "已保存", variant: "success" });
  };

  const removeInstance = async (id: string) => {
    const ok = await confirm({
      message: `删除连接 #${id}？`,
      detail: "凭证(API key)不会被删除——它是独立的,其它连接仍可使用。",
      destructive: true,
    });
    if (!ok) return;
    const next = instances.filter((i) => i.id !== id);
    const nextDefault = defaultId === id ? next[0]?.id ?? "" : defaultId;
    setInstances(next);
    setDefaultId(nextDefault);
    await persist(next, credentials, nextDefault);
    toast({ message: `已删除 ${id}`, variant: "success" });
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">{heading}</h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>
              <Plus />
              添加模型
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
          <ConnField label="后台任务模型" hint="记忆提取、自动标题等后台调用用此模型。">
            <SimpleSelect
              value={auxId}
              onChange={(v) => void setAux(v)}
              placeholder="跟随当前模型"
              options={[
                { value: "", label: "跟随当前模型（默认）" },
                ...instances.map((i) => ({
                  value: i.id,
                  label: `${entryById(i.catalogId)?.displayName ?? i.catalogId} · ${i.model}`,
                })),
              ]}
            />
          </ConnField>
          <p className="text-xs leading-relaxed text-muted-foreground">
            选个便宜快的模型处理后台任务，默认跟随当前聊天模型。
          </p>
        </div>
      )}

      {instances.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          还没有{heading}。点「添加模型」从模板挑一家、选模型、填 key。
        </div>
      ) : (
        <ConnCardGrid>
          {instances.map((inst) => {
            const entry = entryById(inst.catalogId);
            const preset = entry?.modelPresets?.find((p) => p.value === inst.model);
            const credChoices = credentialCandidates(credentials, inst.catalogId);
            const boundCred = credentials.find((c) => c.id === inst.credentialId);
            const isDefault = inst.id === defaultId;
            return (
              <ConnCard key={inst.id} isDefault={isDefault}>
                <header className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <strong className="truncate text-sm font-medium text-foreground">
                      {entry?.displayName ?? inst.catalogId}
                    </strong>
                    {isDefault && <Badge variant="accent">当前</Badge>}
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

                <ConnField label="模型">
                  <SimpleSelect
                    value={inst.model}
                    onChange={(v) => patch(inst.id, { model: v })}
                    options={(entry?.modelPresets ?? []).map((p) => ({
                      value: p.value,
                      label: p.label ?? p.value,
                    }))}
                    placeholder={inst.model || "选择模型"}
                  />
                </ConnField>

                {entry?.needsKey !== false && (
                  <>
                    {credChoices.length > 0 && (
                      <ConnField label="凭证" hint="多个连接可共用一把 key;删连接不会删凭证。">
                        <SimpleSelect
                          value={inst.credentialId ?? ""}
                          onChange={(v) => patch(inst.id, { credentialId: v || undefined })}
                          options={[
                            ...credChoices.map((c) => ({
                              value: c.id,
                              label: credentialLabel(c, entry?.displayName),
                            })),
                            { value: "", label: "填新 key…" },
                          ]}
                          placeholder="选择凭证"
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
                      setDefaultId(inst.id);
                      void persist(instances, credentials, inst.id);
                    }}
                  >
                    {isDefault ? "当前" : "设为当前"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void saveInstance(inst.id)}>
                    保存
                  </Button>
                  <ConnFooterRight>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-status-err"
                      onClick={() => void removeInstance(inst.id)}
                    >
                      删除
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
