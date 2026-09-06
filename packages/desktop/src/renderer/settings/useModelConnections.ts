import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readScopedSettings } from "../settingsAuthority";
import type { CatalogEntry } from "../../preload/types";
import { writeSettings } from "../settingsBus";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import { cacheGet, cacheSet } from "./settingsCache";
import {
  buildInstance,
  credentialCandidates,
  removeCredentialAndReferences,
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
  pending: boolean;
  loading: boolean;
  hasLoaded: boolean;
  loadFailed: boolean;
  credentialCommitRevision: number;
  textTemplates: CatalogEntry[];
  entryById: (id: string) => CatalogEntry | undefined;
  load: () => Promise<void>;
  persist: (next: ModelInstance[], nextCreds: Credential[], nextDefault: string) => Promise<void>;
  addFromTemplate: (entry: CatalogEntry, model?: string) => Promise<void>;
  patch: (id: string, p: Partial<ModelInstance>) => void;
  setConnectionKey: (inst: ModelInstance, apiKey: string) => SetConnectionKeyResult;
  saveInstance: (id: string) => Promise<void>;
  removeInstance: (id: string) => Promise<void>;
  removeCredential: (id: string) => Promise<void>;
  setAux: (id: string) => Promise<void>;
  setDefaultInstance: (id: string) => Promise<void>;
  toggleShowKey: (id: string) => void;
}

export function useModelConnections(
  scope: "user" | "project",
  projectPath: string | undefined,
  tag: ConnTag,
): UseModelConnectionsResult {
  const cacheKey = `conn:${tag}:${scope}:${projectPath ?? ""}`;
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
  const [pending, setPending] = useState(false);
  const [credentialCommitRevision, setCredentialCommitRevision] = useState(0);
  const mutationLock = useRef(false);
  const loadGeneration = useRef(0);
  const mounted = useRef(true);
  const currentScope = useRef(cacheKey);
  currentScope.current = cacheKey;
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGeneration.current += 1;
    };
  }, [cacheKey]);

  const textTemplates = useMemo(() => catalog.filter((e) => e.tag === tag), [catalog, tag]);
  const entryById = useCallback((id: string) => catalog.find((e) => e.id === id), [catalog]);

  const load = useCallback(async () => {
    if (!mounted.current || currentScope.current !== cacheKey) return;
    const generation = ++loadGeneration.current;
    const isCurrent = () =>
      mounted.current && currentScope.current === cacheKey && generation === loadGeneration.current;
    setLoadingKey(cacheKey);
    try {
      // Catalog and settings are one editable snapshot. Neither may be applied
      // alone, or a failed read could replace a real connection with an empty UI.
      const [cat, settings] = await Promise.all([
        window.codeshell.getModelCatalog(),
        readScopedSettings(scope, projectPath),
      ]);
      const s = (settings ?? {}) as Record<string, unknown>;
      let fallback: SttFallback | null = null;
      if (tag === "audio") {
        const d = await window.codeshell.sttDescribe(projectPath ?? "").catch(() => null);
        fallback =
          d?.source === "fallback"
            ? {
                model: d.model,
                maskedKey: d.maskedKey,
                reusedCredentialCatalogId: d.reusedCredentialCatalogId,
              }
            : null;
      }
      if (!isCurrent()) return;
      const conns = Array.isArray(s.modelConnections)
        ? (s.modelConnections as ModelInstance[])
        : [];
      const mine = conns.filter((c) => c.tag === tag);
      const defaults = (s.defaults ?? {}) as Record<string, string | undefined>;
      setCatalog(cat as CatalogEntry[]);
      setInstances(mine);
      cacheSet(cacheKey, mine);
      setCredentials(Array.isArray(s.credentials) ? (s.credentials as Credential[]) : []);
      setDefaultId(defaults[tag] ?? "");
      setAuxId(defaults.auxText ?? "");
      setSttFallback(fallback);
      setLoadedKey(cacheKey);
      setFailedKey(null);
    } catch {
      // Never expose raw read errors, which may contain credential data.
      if (isCurrent()) setFailedKey(cacheKey);
    } finally {
      if (isCurrent()) setLoadingKey(null);
    }
  }, [scope, projectPath, cacheKey, tag]);

  const persist = useCallback(
    async (next: ModelInstance[], nextCreds: Credential[], nextDefault: string) => {
      const s = ((await readScopedSettings(scope, projectPath)) ?? {}) as Record<string, unknown>;
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
        projectPath,
      );
      // Every connection write commits the whole credential collection, even
      // when initiated from another card. End draft editing across the panel.
      setCredentialCommitRevision((revision) => revision + 1);
    },
    [scope, projectPath, tag],
  );

  const runMutation = useCallback(
    async (operation: () => Promise<string | false | undefined>, failureMessage: string) => {
      if (mutationLock.current) return;
      mutationLock.current = true;
      // Reads begun before this action must not overwrite its retained draft.
      loadGeneration.current += 1;
      setLoadingKey(null);
      setPending(true);
      try {
        const message = await operation();
        if (message === false) return;
        // Complete a newer read before unlocking; writeSettings also broadcasts
        // an automatic refresh, which may arrive after this one.
        await load().catch(() => {});
        if (message) toast({ message, variant: "success" });
      } catch {
        // Storage errors can contain credential values. Only show safe text.
        toast({ message: failureMessage, variant: "error" });
      } finally {
        mutationLock.current = false;
        setPending(false);
      }
    },
    [load, toast],
  );

  const setAux = useCallback(
    (id: string) =>
      runMutation(async () => {
        const s = ((await readScopedSettings(scope, projectPath)) ?? {}) as Record<string, unknown>;
        const defaults = (s.defaults ?? {}) as Record<string, unknown>;
        await writeSettings(
          scope,
          { defaults: { ...defaults, auxText: id || undefined } },
          projectPath,
        );
        setAuxId(id);
        return id
          ? t("settingsX.textConn.toastAuxSet", { id })
          : t("settingsX.textConn.toastAuxFollow");
      }, t("settingsX.textConn.toastAuxFailed")),
    [scope, projectPath, runMutation, t],
  );

  const addFromTemplate = useCallback(
    (entry: CatalogEntry, model?: string) =>
      runMutation(async () => {
        const taken = new Set(instances.map((i) => i.id));
        const inst = buildInstance(entry, model, taken, tag);
        const existing = credentialCandidates(credentials, entry.id, catalog)[0];
        if (existing) inst.credentialId = existing.id;
        const next = [...instances, inst];
        const nextDefault = defaultId || inst.id;
        await persist(next, credentials, nextDefault);
        setInstances(next);
        setDefaultId(nextDefault);
        return t("settingsX.textConn.toastAdded", { id: inst.id });
      }, t("settingsX.textConn.toastAddFailed")),
    [catalog, credentials, defaultId, instances, persist, runMutation, t, tag],
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
      if (mutationLock.current) return;
      mutationLock.current = true;
      setPending(true);
      try {
        await persist(instances, credentials, defaultId || id);
        if (!defaultId) setDefaultId(id);
        // The write broadcasts a refresh. Complete a newer read while the
        // form is locked so that delayed readbacks cannot erase later edits.
        await load().catch(() => {});
        toast({ message: t("settingsX.textConn.toastSaved"), variant: "success" });
      } catch {
        // Persistence errors may include credential data. Keep the editable
        // draft and report a safe message without echoing the backend error.
        toast({ message: t("settingsX.textConn.toastSaveFailed"), variant: "error" });
      } finally {
        mutationLock.current = false;
        setPending(false);
      }
    },
    [credentials, defaultId, instances, load, persist, t, toast],
  );

  const removeInstance = useCallback(
    async (id: string) => {
      if (mutationLock.current) return;
      mutationLock.current = true;
      try {
        const ok = await confirm({
          message: t("settingsX.textConn.confirmRemoveMsg", { id }),
          detail: t("settingsX.textConn.confirmRemoveDetail"),
          destructive: true,
        });
        if (!ok) return;
        setPending(true);
        const next = instances.filter((i) => i.id !== id);
        const nextDefault = defaultId === id ? (next[0]?.id ?? "") : defaultId;
        await persist(next, credentials, nextDefault);
        setInstances((current) => current.filter((instance) => instance.id !== id));
        setDefaultId((current) => (current === id ? (next[0]?.id ?? "") : current));
        await load().catch(() => {});
        toast({ message: t("settingsX.textConn.toastRemoved", { id }), variant: "success" });
      } catch {
        toast({ message: t("settingsX.textConn.toastRemoveFailed"), variant: "error" });
      } finally {
        mutationLock.current = false;
        setPending(false);
      }
    },
    [confirm, credentials, defaultId, instances, load, persist, t, toast],
  );

  const removeCredential = useCallback(
    (id: string) =>
      runMutation(async () => {
        const settings = ((await readScopedSettings(scope, projectPath)) ?? {}) as Record<
          string,
          unknown
        >;
        const allConnections = Array.isArray(settings.modelConnections)
          ? (settings.modelConnections as ModelInstance[])
          : [];
        const allCredentials = Array.isArray(settings.credentials)
          ? (settings.credentials as Credential[])
          : [];
        if (!allCredentials.some((credential) => credential.id === id)) return false;
        const next = removeCredentialAndReferences(allCredentials, allConnections, id);
        const ok = await confirm({
          message: t("settingsX.textConn.confirmRemoveCredentialMsg", { id }),
          detail: t("settingsX.textConn.confirmRemoveCredentialDetail", {
            count: next.affectedConnectionIds.length,
          }),
          destructive: true,
        });
        if (!ok) return false;

        await writeSettings(
          scope,
          { credentials: next.credentials, modelConnections: next.connections },
          projectPath,
        );
        const mine = next.connections.filter((connection) => connection.tag === tag);
        setCredentials(next.credentials);
        setInstances(mine);
        cacheSet(cacheKey, mine);
        setCredentialCommitRevision((revision) => revision + 1);
        return t("settingsX.textConn.toastCredentialRemoved", { id });
      }, t("settingsX.textConn.toastCredentialRemoveFailed")),
    [cacheKey, confirm, projectPath, runMutation, scope, t, tag],
  );

  const setDefaultInstance = useCallback(
    (id: string) =>
      runMutation(async () => {
        await persist(instances, credentials, id);
        setDefaultId(id);
        return undefined;
      }, t("settingsX.textConn.setCurrentFailed")),
    [credentials, instances, persist, runMutation, t],
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
    pending,
    loading: loadingKey === cacheKey,
    hasLoaded: loadedKey === cacheKey,
    loadFailed: failedKey === cacheKey,
    credentialCommitRevision,
    textTemplates,
    entryById,
    load,
    persist,
    addFromTemplate,
    patch,
    setConnectionKey,
    saveInstance,
    removeInstance,
    removeCredential,
    setAux,
    setDefaultInstance,
    toggleShowKey,
  };
}
