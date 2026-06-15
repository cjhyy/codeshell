/**
 * Text (LLM) connection panel — display layer of the unified model catalog
 * (L6a). Renders text-tagged catalog templates → instance cards, with params
 * driven by the model's ParamSpec[] (via ParamControls). Reads/writes
 * settings.modelConnections + settings.defaults.text.
 *
 * NOTE: not yet wired as the active model picker — the engine still consumes
 * the legacy models[]/activeKey path (switched in L6b). This panel proves the
 * catalog-driven UI works against the new instance store without touching the
 * request-sending path. See
 * docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §5.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
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
  buildTextInstance,
  reuseKeyCandidates,
  reuseKeyLabel,
  type ModelInstance,
} from "./textConnections";

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

const CACHE_NS = "text-connections";

export function TextConnectionsPanel({ scope, activeRepoPath }: Props) {
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;
  const cacheKey = `${CACHE_NS}:${scope}:${cwd ?? ""}`;
  const confirm = useConfirm();
  const toast = useToast();

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [instances, setInstances] = useState<ModelInstance[]>(
    () => cacheGet<ModelInstance[]>(cacheKey) ?? [],
  );
  const [defaultId, setDefaultId] = useState<string>("");
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});

  const textTemplates = useMemo(() => catalog.filter((e) => e.tag === "text"), [catalog]);
  const entryById = useCallback(
    (id: string) => catalog.find((e) => e.id === id),
    [catalog],
  );

  const load = useCallback(async () => {
    const cat = (await window.codeshell.getModelCatalog().catch(() => [])) as CatalogEntry[];
    setCatalog(cat);
    const s = ((await window.codeshell.getSettings(scope, cwd)) ?? {}) as Record<string, unknown>;
    const conns = Array.isArray(s.modelConnections) ? (s.modelConnections as ModelInstance[]) : [];
    const text = conns.filter((c) => c.tag === "text");
    setInstances(text);
    cacheSet(cacheKey, text);
    const defaults = (s.defaults ?? {}) as { text?: string };
    setDefaultId(defaults.text ?? "");
  }, [scope, cwd, cacheKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(
    async (next: ModelInstance[], nextDefault: string) => {
      // Merge back with non-text connections so we don't clobber image/video.
      const s = ((await window.codeshell.getSettings(scope, cwd)) ?? {}) as Record<string, unknown>;
      const all = Array.isArray(s.modelConnections) ? (s.modelConnections as ModelInstance[]) : [];
      const nonText = all.filter((c) => c.tag !== "text");
      const defaults = (s.defaults ?? {}) as Record<string, unknown>;
      await writeSettings(
        scope,
        { modelConnections: [...nonText, ...next], defaults: { ...defaults, text: nextDefault || undefined } },
        cwd,
      );
    },
    [scope, cwd],
  );

  const addFromTemplate = async (entry: CatalogEntry, model?: string) => {
    const taken = new Set(instances.map((i) => i.id));
    const inst = buildTextInstance(entry, model, taken);
    const next = [...instances, inst];
    const nextDefault = defaultId || inst.id;
    setInstances(next);
    setDefaultId(nextDefault);
    await persist(next, nextDefault);
    toast({ message: `已添加 ${inst.id}`, variant: "success" });
  };

  const patch = (id: string, p: Partial<ModelInstance>) =>
    setInstances((cur) => cur.map((i) => (i.id === id ? { ...i, ...p } : i)));

  const saveInstance = async (id: string) => {
    const next = instances;
    await persist(next, defaultId || id);
    if (!defaultId) setDefaultId(id);
    toast({ message: "已保存", variant: "success" });
  };

  const removeInstance = async (id: string) => {
    const ok = await confirm({
      message: `删除连接 #${id}？`,
      detail: "已保存的 API key 将一并移除。",
      destructive: true,
    });
    if (!ok) return;
    const next = instances.filter((i) => i.id !== id);
    const nextDefault = defaultId === id ? next[0]?.id ?? "" : defaultId;
    setInstances(next);
    setDefaultId(nextDefault);
    await persist(next, nextDefault);
    toast({ message: `已删除 ${id}`, variant: "success" });
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">文本模型</h3>
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

      {instances.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          还没有文本模型。点「添加模型」从模板挑一家、选模型、填 key。
        </div>
      ) : (
        <ConnCardGrid>
          {instances.map((inst) => {
            const entry = entryById(inst.catalogId);
            const preset = entry?.modelPresets?.find((p) => p.value === inst.model);
            const candidates = reuseKeyCandidates(instances, inst);
            const isDefault = inst.id === defaultId;
            return (
              <ConnCard key={inst.id} isDefault={isDefault}>
                <header className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <strong className="text-sm font-medium text-foreground">
                    {entry?.displayName ?? inst.catalogId}
                  </strong>
                  <span className="font-mono text-xs text-muted-foreground">#{inst.id}</span>
                  {isDefault && <Badge variant="accent">默认</Badge>}
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

                {candidates.length > 0 && !inst.apiKey ? (
                  <ConnField label="复用已有 key">
                    <SimpleSelect
                      value={inst.apiKeyRef ?? ""}
                      onChange={(v) => patch(inst.id, { apiKeyRef: v || undefined })}
                      options={candidates.map((c) => ({
                        value: c.id,
                        label: reuseKeyLabel(c, entryById(c.catalogId)?.displayName),
                      }))}
                      placeholder="选择要复用的连接"
                    />
                  </ConnField>
                ) : (
                  entry?.needsKey !== false && (
                    <ConnField label="API Key">
                      <SecretKeyInput
                        value={inst.apiKey ?? ""}
                        show={Boolean(showKey[inst.id])}
                        onChange={(v) => patch(inst.id, { apiKey: v, apiKeyRef: undefined })}
                        onToggleShow={() => setShowKey((s) => ({ ...s, [inst.id]: !s[inst.id] }))}
                      />
                    </ConnField>
                  )
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
                  <Button variant="outline" size="sm" onClick={() => void saveInstance(inst.id)}>
                    保存
                  </Button>
                  <ConnFooterRight>
                    {!isDefault && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setDefaultId(inst.id);
                          void persist(instances, inst.id);
                        }}
                      >
                        设为默认
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-status-err"
                      onClick={() => void removeInstance(inst.id)}
                      aria-label="删除"
                    >
                      <Trash2 />
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
