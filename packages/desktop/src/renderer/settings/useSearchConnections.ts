import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchProbeInput, SearchProbeResult } from "../../preload/types";
import { readScopedSettings } from "../settingsAuthority";
import { writeSettings } from "../settingsBus";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import { cacheGet, cacheSet } from "./settingsCache";
import { useRefreshOnSettingsChange } from "./useSettingsResource";

export const SEARCH_PROVIDERS = ["serper", "tavily", "searxng"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
export interface SearchProviderState {
  apiKey: string;
  baseUrl: string;
  probe?: SearchProbeResult;
  showKey: boolean;
  dirty: boolean;
}
interface SearchSnapshot {
  defaultProvider: SearchProvider;
  byProvider: Record<SearchProvider, SearchProviderState>;
}
type Action = "save" | "clear" | "default" | "test";
interface FocusRequest {
  source: HTMLElement;
  id?: SearchProvider;
  allowDialog: boolean;
  cancelled: boolean;
}
const initialProvider = (): SearchProviderState => ({
  apiKey: "",
  baseUrl: "",
  showKey: false,
  dirty: false,
});
const initialSnapshot = (): SearchSnapshot => ({
  defaultProvider: "serper",
  byProvider: { serper: initialProvider(), tavily: initialProvider(), searxng: initialProvider() },
});
function isProbeResult(value: unknown): value is SearchProbeResult {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.status === "ok" || rec.status === "error" || rec.status === "unconfigured") &&
    typeof rec.lastProbedAt === "string"
  );
}
function readSnapshot(settings: Record<string, unknown>): SearchSnapshot {
  const search =
    settings.search && typeof settings.search === "object"
      ? (settings.search as Record<string, unknown>)
      : {};
  const providers =
    search.providers && typeof search.providers === "object"
      ? (search.providers as Record<string, Record<string, unknown>>)
      : {};
  const next = initialSnapshot();
  for (const id of SEARCH_PROVIDERS) {
    const bag = providers[id] ?? {};
    next.byProvider[id] = {
      ...initialProvider(),
      apiKey: typeof bag.apiKey === "string" ? bag.apiKey : "",
      baseUrl: typeof bag.baseUrl === "string" ? bag.baseUrl : "",
      probe: isProbeResult(bag.lastProbe) ? bag.lastProbe : undefined,
    };
  }
  // Preserve the legacy single-provider slot and its credential fallback.
  if (SEARCH_PROVIDERS.includes(search.provider as SearchProvider)) {
    next.defaultProvider = search.provider as SearchProvider;
    const active = next.byProvider[next.defaultProvider];
    if (!active.apiKey && typeof search.apiKey === "string") active.apiKey = search.apiKey;
    if (!active.baseUrl && typeof search.baseUrl === "string") active.baseUrl = search.baseUrl;
  }
  return next;
}

/** One editable Search snapshot: reads never replace drafts, and writes commit
 * their captured values without replacing edits made while the host was busy. */
export function useSearchConnections(scope: "user" | "project", projectPath?: string) {
  const cacheKey = `search:${scope}:${projectPath ?? ""}`;
  const [seed] = useState(() => cacheGet<SearchSnapshot>(cacheKey));
  const [snapshot, setSnapshot] = useState<SearchSnapshot>(seed ?? initialSnapshot);
  const snapshotRef = useRef(snapshot);
  const [loaded, setLoaded] = useState(Boolean(seed));
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<{ action: Action; id: SearchProvider } | null>(null);
  const [completedFocus, setCompletedFocus] = useState<FocusRequest | null>(null);
  const focusOwner = useRef<FocusRequest | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const operation = useRef(false);
  const reading = useRef(false);
  const revisions = useRef<Record<SearchProvider, number>>({ serper: 0, tavily: 0, searxng: 0 });
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const update = useCallback((apply: (current: SearchSnapshot) => SearchSnapshot) => {
    const next = apply(snapshotRef.current);
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);
  const rememberFocus = useCallback((id?: SearchProvider, allowDialog = false) => {
    const active = document.activeElement;
    const previous = focusOwner.current;
    const source =
      active instanceof HTMLElement && panelRef.current?.contains(active)
        ? active
        : active === document.body && previous && !previous.cancelled
          ? previous.source
          : null;
    const request = source ? { source, id, allowDialog, cancelled: false } : null;
    focusOwner.current = request;
    return request;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const relinquish = (event: Event) => {
      const owner = focusOwner.current;
      if (!owner || owner.source.contains(event.target as Node | null)) return;
      // This operation's confirmation is portalled outside the settings pane.
      if (
        owner.allowDialog &&
        event.target instanceof Element &&
        event.target.closest('[role="dialog"]')
      )
        return;
      owner.cancelled = true;
    };
    const blur = () => {
      if (focusOwner.current) focusOwner.current.cancelled = true;
    };
    document.addEventListener("pointerdown", relinquish, true);
    document.addEventListener("focusin", relinquish, true);
    window.addEventListener("blur", blur);
    return () => {
      mounted.current = false;
      generation.current += 1;
      focusOwner.current = null;
      document.removeEventListener("pointerdown", relinquish, true);
      document.removeEventListener("focusin", relinquish, true);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const load = useCallback(async () => {
    if (!mounted.current || operation.current) return;
    const request = ++generation.current;
    const focusRequest = rememberFocus();
    reading.current = true;
    setLoading(true);
    try {
      const next = readSnapshot((await readScopedSettings(scope, projectPath)) ?? {});
      if (!mounted.current || request !== generation.current) return;
      cacheSet(cacheKey, next);
      update((current) => ({
        defaultProvider: next.defaultProvider,
        byProvider: Object.fromEntries(
          SEARCH_PROVIDERS.map((id) => [
            id,
            current.byProvider[id].dirty
              ? current.byProvider[id]
              : { ...next.byProvider[id], showKey: current.byProvider[id].showKey },
          ]),
        ) as SearchSnapshot["byProvider"],
      }));
      setLoaded(true);
      setLoadFailed(false);
    } catch {
      if (mounted.current && request === generation.current) setLoadFailed(true);
    } finally {
      if (mounted.current && request === generation.current) {
        reading.current = false;
        setLoading(false);
        if (focusRequest) setCompletedFocus(focusRequest);
      }
    }
  }, [cacheKey, projectPath, rememberFocus, scope, update]);
  useRefreshOnSettingsChange(() => void load(), [load]);

  useEffect(() => {
    if (busy || loading || !completedFocus) return;
    setCompletedFocus(null);
    if (focusOwner.current !== completedFocus) return;
    focusOwner.current = null;
    if (completedFocus.cancelled) return;
    const { source, id } = completedFocus;
    const active = document.activeElement;
    if (active && active !== document.body && active !== source) return;
    const card = id
      ? panelRef.current?.querySelectorAll("article")[SEARCH_PROVIDERS.indexOf(id)]
      : panelRef.current?.querySelector("article");
    const target =
      source.isConnected && !source.matches(":disabled")
        ? source
        : (card?.querySelector<HTMLInputElement>("input") ?? headingRef.current);
    target?.focus();
  }, [busy, completedFocus, loading]);

  const patch = (id: SearchProvider, values: Partial<SearchProviderState>, editing = false) => {
    if (editing) revisions.current[id] += 1;
    update((current) => ({
      ...current,
      byProvider: {
        ...current.byProvider,
        [id]: {
          ...current.byProvider[id],
          ...values,
          ...(editing ? { dirty: true, probe: undefined } : {}),
        },
      },
    }));
  };
  const writeBack = async (next: SearchSnapshot) => {
    const providers: Record<string, Record<string, unknown>> = {};
    for (const id of SEARCH_PROVIDERS) {
      const state = next.byProvider[id];
      const bag: Record<string, unknown> = {};
      if (state.apiKey) bag.apiKey = state.apiKey;
      if (state.baseUrl) bag.baseUrl = state.baseUrl;
      if (state.probe) bag.lastProbe = state.probe;
      if (Object.keys(bag).length) providers[id] = bag;
    }
    const active = next.byProvider[next.defaultProvider];
    await writeSettings(
      scope,
      {
        search: {
          provider: next.defaultProvider,
          apiKey: active.apiKey || undefined,
          baseUrl: active.baseUrl || undefined,
          providers,
        },
      },
      projectPath,
    );
  };
  const commit = (next: SearchSnapshot, capturedRevisions: Record<SearchProvider, number>) => {
    cacheSet(cacheKey, next);
    update((current) => ({
      defaultProvider: next.defaultProvider,
      byProvider: Object.fromEntries(
        SEARCH_PROVIDERS.map((id) => [
          id,
          revisions.current[id] !== capturedRevisions[id]
            ? current.byProvider[id]
            : { ...next.byProvider[id], showKey: current.byProvider[id].showKey },
        ]),
      ) as SearchSnapshot["byProvider"],
    }));
  };
  const run = async (
    action: Action,
    id: SearchProvider,
    work: (current: SearchSnapshot, captured: Record<SearchProvider, number>) => Promise<void>,
  ) => {
    if (operation.current || reading.current || !loaded || loadFailed) return;
    operation.current = true;
    generation.current += 1;
    const focusRequest = rememberFocus(id, action === "clear");
    setBusy({ action, id });
    try {
      await work(snapshotRef.current, { ...revisions.current });
    } catch {
      if (mounted.current) {
        toast({
          message: t(
            action === "clear"
              ? "settingsX.searchConn.toastClearFailed"
              : action === "default"
                ? "settingsX.searchConn.toastDefaultFailed"
                : "settingsX.searchConn.toastSaveFailed",
          ),
          variant: "error",
        });
      }
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(null);
        if (focusRequest) setCompletedFocus(focusRequest);
      }
    }
  };
  const save = (id: SearchProvider) =>
    run("save", id, async (current, captured) => {
      const next = {
        ...current,
        byProvider: { ...current.byProvider, [id]: { ...current.byProvider[id], dirty: false } },
      };
      await writeBack(next);
      if (!mounted.current) return;
      commit(next, captured);
      toast({ message: t("settingsX.searchConn.toastSaved") });
    });
  const clear = (id: SearchProvider, name: string) =>
    run("clear", id, async () => {
      const accepted = await confirm({
        message: t("settingsX.searchConn.confirmClearMsg", { name }),
        detail: t("settingsX.searchConn.confirmClearDetail"),
        destructive: true,
      });
      if (!accepted || !mounted.current) return;
      const current = snapshotRef.current;
      const captured = { ...revisions.current };
      const next = { ...current, byProvider: { ...current.byProvider, [id]: initialProvider() } };
      await writeBack(next);
      if (mounted.current) commit(next, captured);
    });
  const setDefault = (id: SearchProvider) =>
    run("default", id, async (current, captured) => {
      const next = { ...current, defaultProvider: id };
      await writeBack(next);
      if (mounted.current) commit(next, captured);
    });
  const test = (id: SearchProvider) =>
    run("test", id, async (current, captured) => {
      const state = current.byProvider[id];
      const input: SearchProbeInput = {
        provider: id,
        apiKey: state.apiKey || undefined,
        baseUrl: state.baseUrl || undefined,
      };
      let result: SearchProbeResult;
      try {
        result = await window.codeshell.probeSearch(input);
      } catch (error) {
        result = {
          status: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          lastProbedAt: new Date().toISOString(),
        };
      }
      if (!mounted.current) return;
      const next = {
        ...current,
        byProvider: { ...current.byProvider, [id]: { ...state, probe: result } },
      };
      if (revisions.current[id] === captured[id]) patch(id, { probe: result });
      if (result.status === "ok") {
        await writeBack(next);
        if (mounted.current) commit(next, captured);
      }
    });
  return {
    ...snapshot,
    loaded,
    loading,
    loadFailed,
    busy,
    panelRef,
    headingRef,
    load,
    patch,
    save,
    clear,
    setDefault,
    test,
  };
}
