import { useCallback, useEffect, useRef, useState } from "react";
import type { ExternalRuntimeModelEntry } from "../../shared/external-runtime-models";
import type { CcRoomSettingsState, MobilePermissionMode } from "../../shared/mobile-remote";

const busyLabels = {
  switching: "正在切换设置，等待电脑确认…",
  retiring: "正在等待旧进程退出…",
  turn: "任务完成或停止后可调整模型和权限。",
  approval: "先处理待确认的操作，再调整设置。",
  queued: "先执行或取消排队消息，再调整设置。",
};

/** Settings never reset the conversation or its draft, and always reflect Main's receipt. */
export function useCcRoomSettings(input: {
  roomId: string;
  sessionId: string;
  cwd: string | null;
  kind: "claude-code" | "codex";
  mode: string;
  modelKey?: string | null;
  active: boolean;
  observing: boolean;
  localBlock?: string;
  isSending(): boolean;
  onApplied?: (settings: { permissionMode: MobilePermissionMode; modelKey: string | null }) => void;
}) {
  const current = useRef(input);
  current.current = input;
  const [state, setState] = useState<CcRoomSettingsState>();
  const [models, setModels] = useState<ExternalRuntimeModelEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [changeError, setChangeError] = useState<string>();
  const [switching, setSwitching] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const requestRef = useRef<object | null>(null);
  const readSequence = useRef(0);
  const supported = !!window.codeshell.ccRoom.settingsState;
  const matchesState = (candidate: CcRoomSettingsState | undefined, target: typeof input) =>
    candidate?.roomId === target.roomId &&
    candidate.sessionId === target.sessionId &&
    candidate.kind === target.kind &&
    candidate.cwd === target.cwd;
  const displayedState = matchesState(state, input) ? state : undefined;
  const targetMatches = (target: typeof input) => {
    const now = current.current;
    return (
      now.roomId === target.roomId &&
      now.sessionId === target.sessionId &&
      now.cwd === target.cwd &&
      now.kind === target.kind
    );
  };
  const refresh = useCallback(async () => {
    const target = current.current;
    if (
      !target.active ||
      document.visibilityState === "hidden" ||
      requestRef.current ||
      !window.codeshell.ccRoom.settingsState
    )
      return;
    const sequence = ++readSequence.current;
    try {
      const next = await window.codeshell.ccRoom.settingsState(target.roomId);
      if (sequence !== readSequence.current || !targetMatches(target) || requestRef.current) return;
      if (
        next.roomId !== target.roomId ||
        next.sessionId !== target.sessionId ||
        next.kind !== target.kind ||
        next.cwd !== target.cwd
      ) {
        setState(undefined);
        setError("会话设置与当前会话不匹配，请重新打开。");
        return;
      }
      setState(next);
      setError(undefined);
    } catch (cause) {
      if (sequence !== readSequence.current || !targetMatches(target) || requestRef.current) return;
      setState(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    setState(undefined);
    setError(undefined);
    setChangeError(undefined);
    setSwitching(false);
    requestRef.current = null;
    readSequence.current++;
    if (!input.active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    const off = window.codeshell.ccRoom.onRoomState?.((room) => {
      if (room.id === current.current.roomId) void refresh();
    });
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      off?.();
      readSequence.current++;
      requestRef.current = null;
    };
  }, [input.roomId, input.sessionId, input.cwd, input.kind, input.active, refresh]);

  useEffect(() => {
    // Observation must not probe or start a CLI merely to populate its model menu.
    let cancelled = false;
    setModels([]);
    setModelsLoading(false);
    if (!input.active || input.observing || !window.codeshell.externalRuntime?.models) return;
    setModelsLoading(true);
    void window.codeshell.externalRuntime
      .models()
      .then((entries) => {
        if (!cancelled) setModels(entries.filter((entry) => entry.kind === input.kind));
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [input.kind, input.active, input.observing, catalogRevision]);

  const blocked = !input.active
    ? "切回此会话后可调整。"
    : input.observing || displayedState?.observing
      ? "此会话当前仅可查看。"
      : switching
        ? busyLabels.switching
        : (input.localBlock ??
          (displayedState?.busyReason
            ? busyLabels[displayedState.busyReason]
            : !supported
              ? "更新电脑端后可调整会话设置。"
              : !displayedState
                ? (error ?? "正在读取会话设置…")
                : undefined));
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  const change = async (selection: { mode?: MobilePermissionMode; modelKey?: string | null }) => {
    const target = current.current;
    if (
      blockedRef.current ||
      requestRef.current ||
      target.isSending() ||
      !state ||
      !matchesState(state, target) ||
      !target.cwd
    )
      return;
    if (
      selection.modelKey !== undefined &&
      selection.modelKey !== null &&
      !models.some((entry) => entry.key === selection.modelKey && entry.kind === target.kind)
    )
      return;
    const mode = selection.mode ?? state.permissionMode;
    if (
      mode === state.permissionMode &&
      (selection.modelKey === undefined || selection.modelKey === state.modelKey)
    )
      return;
    const request = {};
    requestRef.current = request;
    readSequence.current++;
    setSwitching(true);
    setChangeError(undefined);
    try {
      const result = await window.codeshell.ccRoom.openSession(
        target.sessionId,
        target.cwd,
        mode,
        target.kind,
        {
          roomId: target.roomId,
          ...(selection.modelKey !== undefined ? { modelKey: selection.modelKey } : {}),
        },
      );
      if (requestRef.current !== request || !targetMatches(target)) return;
      if (
        result.roomId !== target.roomId ||
        result.status !== "running" ||
        !result.permissionMode ||
        result.modelKey === undefined
      )
        throw new Error("电脑未确认会话设置，请刷新后重试。");
      readSequence.current++;
      setState(
        (before) =>
          before && {
            ...before,
            permissionMode: result.permissionMode!,
            modelKey: result.modelKey!,
            busyReason: undefined,
          },
      );
      target.onApplied?.({ permissionMode: result.permissionMode, modelKey: result.modelKey });
    } catch (cause) {
      if (requestRef.current === request && targetMatches(target))
        setChangeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestRef.current === request && targetMatches(target)) {
        requestRef.current = null;
        setSwitching(false);
      }
    }
  };
  return {
    mode: displayedState?.permissionMode ?? input.mode,
    modelKey: displayedState ? displayedState.modelKey : (input.modelKey ?? null),
    models,
    modelsLoading,
    error: changeError ?? error,
    blocked,
    switching,
    change,
    isChanging: () => requestRef.current !== null,
    refresh,
    refreshModels: () => setCatalogRevision((revision) => revision + 1),
  };
}
