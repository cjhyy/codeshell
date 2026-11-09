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

/**
 * The hidden-window "agent done" notification, unless a notice rule watches
 * (or just fired for) this Session: main's notice router owns that one.
 */
export async function notifyAgentDone(
  sessionId: string | null | undefined,
  input: { title: string; body: string },
  deps: {
    bell?: Pick<PetApi, "getSessionBell">;
    notify: (input: { title: string; body: string }) => Promise<unknown>;
  } = { bell: bellApi(), notify: (input) => window.codeshell.notify(input) },
): Promise<void> {
  if (sessionId && deps.bell?.getSessionBell) {
    try {
      const bell = await deps.bell.getSessionBell(sessionId);
      if (bell.on || bell.firedRecently) return;
    } catch {
      // Unknown: notify as before rather than stay silent.
    }
  }
  await deps.notify(input);
}

/** Only Mimi's delegation rule watches the Session: shown, but not the bell's to switch off. */
export function isDelegatedOnly(state: PetSessionBellState): boolean {
  return state.on && state.origin === "delegation";
}

/** The bell's tooltip: what will happen, and whether that IM can deliver yet. */
export function sessionBellLabel(state: PetSessionBellState, t: TFunction): string {
  if (!state.on) return t("pet.notices.bellOff");
  if (isDelegatedOnly(state)) return t("pet.notices.bellDelegated");
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
  const readOnly = isDelegatedOnly(state);
  return (
    <IconButton
      label={label}
      active={state.on}
      disabled={pending}
      // Read-only stays hoverable (a disabled button shows no tooltip).
      aria-disabled={readOnly || undefined}
      data-session-bell={readOnly ? "delegated" : state.on ? "on" : "off"}
      data-session-bell-ready={notReady ? "not-ready" : undefined}
      onClick={readOnly ? undefined : onToggle}
    >
      {state.on ? (
        <BellRing
          size={14}
          className={
            readOnly ? "text-muted-foreground" : notReady ? "text-status-warn" : "text-primary"
          }
        />
      ) : (
        <Bell size={14} />
      )}
    </IconButton>
  );
}

interface SessionBell {
  sessionId: string;
  bell: PetSessionBellState;
}

/**
 * "Tell me when this Session is done" for the open work Session. Main answers
 * `available: false` for Sessions it cannot watch (Mimi's own, external
 * runtimes, unknown ids), and the bell then stays hidden. `refreshKey`
 * re-reads it (e.g. when a run ends). Every reply is kept with the Session it
 * was for, so a late answer about the previous Session is never shown or
 * toggled from.
 */
export function SessionNoticeBell({
  sessionId,
  refreshKey,
}: {
  sessionId: string | null | undefined;
  refreshKey?: unknown;
}) {
  const [state, setState] = useState<SessionBell | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ sessionId: string; message: string } | null>(null);
  const request = useRef(0);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;

  useEffect(() => {
    const api = bellApi();
    if (!sessionId || !api?.getSessionBell) return;
    let alive = true;
    const load = (): void => {
      const id = ++request.current;
      api.getSessionBell!(sessionId).then(
        (bell) => {
          if (alive && id === request.current) setState({ sessionId, bell });
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
      // Whatever is still in flight belongs to this Session; drop it.
      request.current += 1;
      off?.();
    };
  }, [sessionId, refreshKey]);

  const bell = state && state.sessionId === sessionId ? state.bell : null;
  if (!sessionId || !bell?.available) return null;
  const busy = pending === sessionId;
  const toggle = (): void => {
    const api = bellApi();
    if (!api?.setSessionBell || busy || isDelegatedOnly(bell)) return;
    const target = sessionId;
    const id = ++request.current;
    setPending(target);
    setError(null);
    api.setSessionBell(target, !bell.on).then(
      (next) => {
        if (id === request.current && currentSession.current === target)
          setState({ sessionId: target, bell: next });
        setPending((current) => (current === target ? null : current));
      },
      (cause: unknown) => {
        if (currentSession.current === target)
          setError({
            sessionId: target,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        setPending((current) => (current === target ? null : current));
      },
    );
  };
  return (
    // The title bar is a window drag region; the bell must opt back out.
    <span style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <SessionNoticeBellButton
        state={bell}
        pending={busy}
        error={error?.sessionId === sessionId ? error.message : null}
        onToggle={toggle}
      />
    </span>
  );
}
