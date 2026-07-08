import { useCallback, useMemo, useState } from "react";
import type { CatalogEntry } from "../../preload/types";
import { writeSettings } from "../settingsBus";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import { cacheGet, cacheSet } from "./settingsCache";
import {
  buildInstance,
  credentialCandidates,
  uniqueInstanceId,
  type Credential,
  type ModelInstance,
} from "./textConnections";

export type ConnTag = ModelInstance["tag"];

export interface SttFallback {
  model?: string;
  maskedKey?: string;
  reusedCredentialCatalogId?: string;
}

export interface SetConnectionKeyResult {
  credId: string | undefined;
  nextCreds: Credential[];
}

export interface UseModelConnectionsResult {
  catalog: CatalogEntry[];
  instances: ModelInstance[];
  credentials: Credential[];
  defaultId: string;
  auxId: string;
  showKey: Record<string, boolean>;
  sttFallback: SttFallback | null;
  textTemplates: CatalogEntry[];
  entryById: (id: string) => CatalogEntry | undefined;
  load: () => Promise<void>;
  persist: (next: ModelInstance[], nextCreds: Credential[], nextDefault: string) => Promise<void>;
  addFromTemplate: (entry: CatalogEntry, model?: string) => Promise<void>;
  patch: (id: string, p: Partial<ModelInstance>) => void;
  setConnectionKey: (inst: ModelInstance, apiKey: string) => SetConnectionKeyResult;
  saveInstance: (id: string) => Promise<void>;
  removeInstance: (id: string) => Promise<void>;
  setAux: (id: string) => Promise<void>;
  setDefaultInstance: (id: string) => void;
  toggleShowKey: (id: string) => void;
}

export function useModelConnections(
  scope: "user" | "project",
  cwd: string | undefined,
  tag: ConnTag,
): UseModelConnectionsResult {
  const cacheKey = `conn:${tag}:${scope}:${cwd ?? ""}`;
  const { t } = useT();
  const confirm = useConfirm();
  const toast = useToast();

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [instances, setInstances] = useState<ModelInstance[]>(
    () => cacheGet<ModelInstance[]>(cacheKey) ?? [],
  );
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [defaultId, setDefaultId] = useState<string>("");
  const [auxId, setAuxId] = useState<string>("");
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [sttFallback, setSttFallback] = useState<SttFallback | null>(null);

  const textTemplates = useMemo(() => catalog.filter((e) => e.tag === tag), [catalog, tag]);
  const entryById = useCallback((id: string) => catalog.find((e) => e.id === id), [catalog]);

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
    if (tag === "audio") {
      try {
        const d = await window.codeshell.sttDescribe(cwd ?? "");
        setSttFallback(
          d.source === "fallback"
            ? {
                model: d.model,
                maskedKey: d.maskedKey,
                reusedCredentialCatalogId: d.reusedCredentialCatalogId,
              }
            : null,
        );
      } catch {
        setSttFallback(null);
      }
    } else {
      setSttFallback(null);
    }
  }, [scope, cwd, cacheKey, tag]);

  const persist = useCallback(
    async (next: ModelInstance[], nextCreds: Credential[], nextDefault: string) => {
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

  const setAux = useCallback(
    async (id: string) => {
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
    },
    [scope, cwd, t, toast],
  );

  const addFromTemplate = useCallback(
    async (entry: CatalogEntry, model?: string) => {
      const taken = new Set(instances.map((i) => i.id));
      const inst = buildInstance(entry, model, taken, tag);
      const existing = credentialCandidates(credentials, entry.id, catalog)[0];
      if (existing) inst.credentialId = existing.id;
      const next = [...instances, inst];
      const nextDefault = defaultId || inst.id;
      setInstances(next);
      setDefaultId(nextDefault);
      await persist(next, credentials, nextDefault);
      toast({ message: t("settingsX.textConn.toastAdded", { id: inst.id }), variant: "success" });
    },
    [catalog, credentials, defaultId, instances, persist, t, tag, toast],
  );

  const patch = useCallback(
    (id: string, p: Partial<ModelInstance>) =>
      setInstances((cur) => cur.map((i) => (i.id === id ? { ...i, ...p } : i))),
    [],
  );

  const setConnectionKey = useCallback(
    (inst: ModelInstance, apiKey: string) => {
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
    },
    [credentials, patch],
  );

  const saveInstance = useCallback(
    async (id: string) => {
      await persist(instances, credentials, defaultId || id);
      if (!defaultId) setDefaultId(id);
      toast({ message: t("settingsX.textConn.toastSaved"), variant: "success" });
    },
    [credentials, defaultId, instances, persist, t, toast],
  );

  const removeInstance = useCallback(
    async (id: string) => {
      const ok = await confirm({
        message: t("settingsX.textConn.confirmRemoveMsg", { id }),
        detail: t("settingsX.textConn.confirmRemoveDetail"),
        destructive: true,
      });
      if (!ok) return;
      const next = instances.filter((i) => i.id !== id);
      const nextDefault = defaultId === id ? (next[0]?.id ?? "") : defaultId;
      setInstances(next);
      setDefaultId(nextDefault);
      await persist(next, credentials, nextDefault);
      toast({ message: t("settingsX.textConn.toastRemoved", { id }), variant: "success" });
    },
    [confirm, credentials, defaultId, instances, persist, t, toast],
  );

  const setDefaultInstance = useCallback(
    (id: string) => {
      const prevDefault = defaultId;
      setDefaultId(id);
      void persist(instances, credentials, id).catch((e) => {
        setDefaultId(prevDefault);
        toast({
          message: `${t("settingsX.textConn.setCurrentFailed")}: ${
            e instanceof Error ? e.message : String(e)
          }`,
          variant: "error",
        });
      });
    },
    [credentials, defaultId, instances, persist, t, toast],
  );

  const toggleShowKey = useCallback(
    (id: string) => setShowKey((s) => ({ ...s, [id]: !s[id] })),
    [],
  );

  return {
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
    persist,
    addFromTemplate,
    patch,
    setConnectionKey,
    saveInstance,
    removeInstance,
    setAux,
    setDefaultInstance,
    toggleShowKey,
  };
}
