import React, { useEffect, useRef, useState } from "react";
import { Bell, BellRing } from "lucide-react";
import { IconButton } from "../ui/IconButton";
import { useT, type TFunction } from "../i18n";
import type { PetSessionBellState } from "../../shared/pet-notices";
import type { PetApi } from "../../preload/pet-api";

type BellApi = Pick<PetApi, "getSessionBell" | "setSessionBell" | "onNoticesChanged">;

function bellApi(): BellApi | undefined {
  try {
    return window.codeshell?.pet;
  } catch {
    return undefined;
  }
}

/** The bell's tooltip: what will happen, and whether that IM can deliver yet. */
export function sessionBellLabel(state: PetSessionBellState, t: TFunction): string {
  if (!state.on) return t("pet.notices.bellOff");
  const target = state.imLabel ?? t("pet.notices.bellDesktop");
  const label = t("pet.notices.bellOn", { target });
  return state.imLabel && state.ready && state.ready !== "ready"
    ? label + t("pet.notices.bellNotReady", { target: state.imLabel })
    : label;
}

export function SessionNoticeBellButton({
  state,
  pending = false,
  error,
  onToggle,
}: {
  state: PetSessionBellState;
  pending?: boolean;
  error?: string | null;
  onToggle: () => void;
}) {
  const { t } = useT();
  const label = error
    ? `${sessionBellLabel(state, t)} · ${t("pet.notices.bellFailed", { error })}`
    : sessionBellLabel(state, t);
  const notReady = state.on && !!state.imLabel && !!state.ready && state.ready !== "ready";
  return (
    <IconButton
      label={label}
      active={state.on}
      disabled={pending}
      data-session-bell={state.on ? "on" : "off"}
      data-session-bell-ready={notReady ? "not-ready" : undefined}
      onClick={onToggle}
    >
      {state.on ? (
        <BellRing size={14} className={notReady ? "text-status-warn" : "text-primary"} />
      ) : (
        <Bell size={14} />
      )}
    </IconButton>
  );
}

/**
 * "Tell me when this Session is done" for the open work Session. Main refuses
 * Sessions it cannot watch (Mimi's own, external runtimes, unknown ids), and
 * the bell then stays hidden. `refreshKey` re-reads it (e.g. when a run ends).
 */
export function SessionNoticeBell({
  sessionId,
  refreshKey,
}: {
  sessionId: string | null | undefined;
  refreshKey?: unknown;
}) {
  const [state, setState] = useState<PetSessionBellState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const api = bellApi();
    setError(null);
    if (!sessionId || !api?.getSessionBell) {
      setState(null);
      return;
    }
    let alive = true;
    const load = (): void => {
      const id = ++request.current;
      api.getSessionBell!(sessionId).then(
        (next) => {
          if (alive && id === request.current) setState(next);
        },
        () => {
          if (alive && id === request.current) setState(null);
        },
      );
    };
    load();
    const off = api.onNoticesChanged?.(load);
    return () => {
      alive = false;
      off?.();
    };
  }, [sessionId, refreshKey]);

  if (!sessionId || !state) return null;
  const toggle = (): void => {
    const api = bellApi();
    if (!api?.setSessionBell || pending) return;
    const id = ++request.current;
    setPending(true);
    setError(null);
    api.setSessionBell(sessionId, !state.on).then(
      (next) => {
        if (id === request.current) setState(next);
        setPending(false);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setPending(false);
      },
    );
  };
  return (
    // The title bar is a window drag region; the bell must opt back out.
    <span style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <SessionNoticeBellButton state={state} pending={pending} error={error} onToggle={toggle} />
    </span>
  );
}
