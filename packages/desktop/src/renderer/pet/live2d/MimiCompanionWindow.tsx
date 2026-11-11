import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  MIMI_COMPANION_QUICK_SIZES,
  type MimiCompanionApi,
  type MimiCompanionState,
} from "../../../shared/mimi-companion";
import { effectAction, SPRITE_EFFECTS, type CharacterRenderer } from "./character-renderer";
import { companionLocomotion, HOP_MS, type CompanionLocomotion } from "./companion-locomotion";
import { companionActionLabel, companionYields } from "./companion-pose";
import { companionCueDuration } from "./sprite-animation";
import { PoseActor } from "./PoseActor";
import { spriteCharacter } from "./sprite-characters";
import { SpriteActor } from "./SpriteActor";
import { useT } from "../../i18n";
import "./companion.css";

declare global {
  interface Window {
    mimiCompanion: MimiCompanionApi;
  }
}
export const CHARACTER_RENDERERS: Record<MimiCompanionState["appearance"], CharacterRenderer> = {
  "mimi-sprite": {
    id: "mimi-sprite",
    label: "Mimi 动画集",
    Actor: SpriteActor,
    effects: SPRITE_EFFECTS,
  },
  "shiro-sprite": {
    id: "shiro-sprite",
    label: "Shiro 姿势集",
    Actor: PoseActor,
    effects: SPRITE_EFFECTS,
    pace: "fly",
  },
  "maki-sprite": {
    id: "maki-sprite",
    label: "Maki 姿势集",
    Actor: PoseActor,
    effects: SPRITE_EFFECTS,
    pace: "fly",
  },
};

type Gesture = {
  pointerId: number;
  target: HTMLButtonElement;
  startX: number;
  startY: number;
  origin: { x: number; y: number };
  lastX: number;
  dragged: boolean;
};

function hitsInteractiveContent(x: number, y: number): boolean {
  return Boolean(
    document
      .elementFromPoint(x, y)
      ?.closest(
        ".mimi-companion__body, .mimi-companion__badge, .mimi-companion__handoff, .mimi-companion__menu",
      ),
  );
}

export function MimiCompanionWindow() {
  const [state, setState] = useState<MimiCompanionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useT();
  // Callbacks registered once still speak the current language.
  const tRef = useRef(t);
  tRef.current = t;
  const [moving, setMoving] = useState<"left" | "right" | null>(null);
  const [hovered, setHovered] = useState(false);
  const [held, setHeld] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const [travel, setTravel] = useState<CompanionLocomotion>({ kind: "none" });
  /** The activity whose move just made contact; shows the impact burst. */
  const [impact, setImpact] = useState<string | null>(null);
  const impactTimer = useRef<number | undefined>(undefined);
  const lastPosition = useRef<{ x: number; y: number } | undefined>(undefined);
  const lastOrigin = useRef<{ x: number; y: number } | undefined>(undefined);
  const travelTimer = useRef<number | undefined>(undefined);
  const [cueActivity, setCueActivity] = useState<MimiCompanionState["activity"] | null>(null);
  const currentCue = useRef<MimiCompanionState["activity"] | null>(null);
  const cueTimer = useRef<number | undefined>(undefined);
  /** The one-shot gesture whose budget waits on the character's arrival. */
  const oneShot = useRef<string | undefined>(undefined);
  const seenActivities = useRef(new Set<string>());
  const gesture = useRef<Gesture | null>(null);
  const mouseActive = useRef(false);
  const interaction = useCallback((phase: Parameters<MimiCompanionApi["interaction"]>[0]) => {
    if (phase !== "end") mouseActive.current = phase !== "leave";
    window.mimiCompanion.interaction(phase);
  }, []);
  const lastHoverAt = useRef(0);
  const hoverNeedsRefresh = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLButtonElement>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const humanActive = Boolean(state?.humanActive || hovered || held || menuOpen);
  const visible = Boolean(state && (state.enabled || state.preview) && state.visible);

  useEffect(() => {
    let alive = true;
    let receivedEvent = false;
    const off = window.mimiCompanion.onState((next) => {
      receivedEvent = true;
      if (alive) setState(next);
    });
    void window.mimiCompanion.getState().then(
      (next) => {
        if (alive && !receivedEvent) setState(next);
      },
      () => {
        if (alive) {
          const message = tRef.current("pet.companion.stateUnavailable");
          setError(message);
          window.mimiCompanion.ready({ error: message });
        }
      },
    );
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setReducedMotion(query.matches);
    query.addEventListener("change", changed);
    return () => {
      alive = false;
      off();
      query.removeEventListener("change", changed);
      window.clearTimeout(cueTimer.current);
      window.clearTimeout(travelTimer.current);
      window.clearTimeout(impactTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    const activity = state.activity;
    const remember = () => {
      seenActivities.current.add(activity.id);
      if (seenActivities.current.size > 64)
        seenActivities.current.delete(seenActivities.current.values().next().value!);
    };
    const stop = () => {
      window.clearTimeout(cueTimer.current);
      cueTimer.current = undefined;
      currentCue.current = null;
      setCueActivity(null);
    };
    const play = (duration?: number) => {
      window.clearTimeout(cueTimer.current);
      currentCue.current = activity;
      setCueActivity(activity);
      cueTimer.current = duration === undefined ? undefined : window.setTimeout(stop, duration);
    };
    if (humanActive || !visible) {
      remember();
      stop();
      return;
    }
    // Looping effects (typing, scrolling, dragging…) last as long as their
    // operation; one-shot gestures start their budget once the walk arrives.
    const effects = (CHARACTER_RENDERERS[state.appearance] ?? CHARACTER_RENDERERS["mimi-sprite"])
      .effects;
    const sustained = activity.action === "type" || effects.loop.has(activity.action);
    const tail = activity.action === "type" ? 900 : 300;
    const previous = currentCue.current;
    if (activity.action === "idle") {
      // The host may clear its completion dwell before our readable typing tail.
      if (previous?.action === "type" && previous.phase === "end") return;
      stop();
      return;
    }
    if (previous?.id === activity.id) {
      // A repeated end or stale start must not extend/restart the same gesture.
      if (previous.phase === "end") return;
      if (activity.action === "error") play(companionCueDuration(state));
      else if (sustained && activity.phase === "end") play(tail);
      else if (activity.phase === "end") {
        currentCue.current = activity;
        setCueActivity(activity);
      }
      return;
    }
    stop();
    if (seenActivities.current.has(activity.id)) return;
    remember();
    if (activity.action === "type" || (sustained && activity.phase === "start")) {
      // Fast input can begin/end within one React render; its real completion
      // still receives a tail. An interrupted id is already consumed above.
      play(activity.phase === "end" ? tail : undefined);
      return;
    }
    // Runs before the travel effect below, so lastPosition is still the origin.
    const trip = companionLocomotion(lastPosition.current, state.position, {
      reducedMotion,
      immediate: Boolean(state.avoidInput) || !visible,
      pace: CHARACTER_RENDERERS[state.appearance]?.pace,
    });
    const arrival = trip.kind === "none" ? 0 : trip.duration;
    const remaining =
      companionCueDuration(state) + arrival - Math.max(0, Date.now() - activity.startedAt);
    oneShot.current = activity.id;
    if (remaining > 0) play(remaining);
  }, [state?.activity.id, state?.activity.action, state?.activity.phase, humanActive, visible]);

  // Host relocations walk (or hop, when far) instead of gliding at one speed.
  // A human drag moves the body directly and is never animated here.
  useEffect(() => {
    if (!state) return;
    const from = lastPosition.current;
    const origin = state.windowOrigin;
    const previousOrigin = lastOrigin.current;
    lastPosition.current = state.position;
    lastOrigin.current = origin;
    if (dragPosition) return;
    // Another display means another overlay window: there is no path to walk.
    const crossed =
      !!origin &&
      !!previousOrigin &&
      (origin.x !== previousOrigin.x || origin.y !== previousOrigin.y);
    const next: CompanionLocomotion =
      crossed && !reducedMotion && visible && !state.avoidInput
        ? { kind: "hop", duration: HOP_MS }
        : companionLocomotion(from, state.position, {
            reducedMotion,
            immediate: Boolean(state.avoidInput) || !visible,
            pace: CHARACTER_RENDERERS[state.appearance]?.pace,
          });
    window.clearTimeout(travelTimer.current);
    setTravel(next);
    if (next.kind !== "none")
      travelTimer.current = window.setTimeout(() => setTravel({ kind: "none" }), next.duration);
    // Pointer targets arrive after their gesture began (the native cursor
    // update). The gesture plays where the character arrives, not before.
    const activity = state.activity;
    if (
      next.kind !== "none" &&
      activity.phase === "start" &&
      oneShot.current === activity.id &&
      !humanActive &&
      visible
    ) {
      window.clearTimeout(cueTimer.current);
      currentCue.current = activity;
      setCueActivity(activity);
      cueTimer.current = window.setTimeout(
        () => {
          cueTimer.current = undefined;
          currentCue.current = null;
          setCueActivity(null);
        },
        next.duration + companionCueDuration(state),
      );
    }
  }, [state?.position.x, state?.position.y, state?.windowOrigin?.x, state?.windowOrigin?.y]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    interaction("end");
    // Closing a menu outside the body must release the native mouse capture.
    // `end` alone deliberately keeps an ordinary body click interactive.
    if (!body.current?.matches(":hover")) {
      setHovered(false);
      interaction("leave");
    }
  }, [interaction]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node)) return;
      // The body's pointer handler has already begun a new drag/click. Do not
      // terminate that gesture while dismissing the old menu in bubbling.
      if (body.current?.contains(event.target as Node)) setMenuOpen(false);
      else closeMenu();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", escape);
    menu.current?.querySelector("button")?.focus();
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", escape);
    };
  }, [menuOpen, closeMenu]);

  const ready = useCallback(() => {
    setError(null);
    window.mimiCompanion.ready();
  }, []);
  const failed = useCallback((message: string) => {
    setError(message);
    window.mimiCompanion.ready({ error: message });
  }, []);
  const openChat = useCallback(() => {
    setError(null);
    hoverNeedsRefresh.current = true;
    void window.mimiCompanion.openChat().then(
      () => {
        hoverNeedsRefresh.current = true;
      },
      () => setError(tRef.current("pet.companion.chatUnavailable")),
    );
  }, []);
  const finishGesture = useCallback(
    (
      event: Pick<PointerEvent, "pointerId" | "clientX" | "clientY"> | undefined,
      cancelled: boolean,
    ) => {
      const current = gesture.current;
      if (!current || (event && current.pointerId !== event.pointerId)) return;
      gesture.current = null;
      if (current.target.hasPointerCapture(current.pointerId))
        current.target.releasePointerCapture(current.pointerId);
      setHeld(false);
      setMoving(null);
      setDragPosition(null);
      interaction("end");
      // Capture retargets pointerup to the body even when the pointer is outside.
      // Reconcile the actual hit now; a later pointerleave is not guaranteed.
      if (cancelled || !event || !hitsInteractiveContent(event.clientX, event.clientY)) {
        setHovered(false);
        interaction("leave");
      }
      if (!cancelled && !current.dragged) openChat();
    },
    [interaction, openChat],
  );
  const resetInteraction = useCallback(() => {
    if (gesture.current) finishGesture(undefined, true);
    else if (mouseActive.current) {
      // The context menu also holds a native interaction, without a pointer gesture.
      interaction("end");
      interaction("leave");
    }
    setHovered(false);
    setMenuOpen(false);
  }, [finishGesture, interaction]);

  useEffect(() => {
    const move = (event: MouseEvent) => {
      // Electron forwards mousemove even while the transparent window yields
      // clicks. Recover a release lost during a window/display transition.
      if (gesture.current && (event.buttons & 1) === 0) finishGesture(undefined, true);
      if (
        mouseActive.current &&
        !gesture.current &&
        !menuOpen &&
        !hitsInteractiveContent(event.clientX, event.clientY)
      ) {
        setHovered(false);
        interaction("leave");
      }
    };
    const hidden = () => {
      if (document.hidden) resetInteraction();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("blur", resetInteraction);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("blur", resetInteraction);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [finishGesture, interaction, menuOpen, resetInteraction]);
  useEffect(() => {
    if (!visible) resetInteraction();
  }, [visible, resetInteraction]);
  useEffect(() => () => resetInteraction(), [resetInteraction]);

  if (!state) return null;
  const { Actor, effects, pace } =
    CHARACTER_RENDERERS[state.appearance] ?? CHARACTER_RENDERERS["mimi-sprite"];
  const cueActive = Boolean(cueActivity && !humanActive && visible);
  const presented =
    cueActive && cueActivity
      ? {
          ...state,
          activity: { ...cueActivity, action: effectAction(effects, cueActivity.action) },
        }
      : state;
  const typing = cueActive && ["type", "key"].includes(presented.activity.action);
  const targetEffect = cueActive && ["click", "scroll", "drag"].includes(presented.activity.action);
  const position = dragPosition ?? state.position;
  const yielding = companionYields(state, humanActive);
  // The docked widget's work badge, carried over her head: what needs the
  // human first, then finished work not yet seen, else a quiet "busy" dot.
  const attention = state.attention;
  const attentionCount = (attention?.needsAction ?? 0) + (attention?.unread ?? 0);
  const showAttention =
    Boolean(attention) && !state.preview && !menuOpen && !held && !state.handoff;
  const answerHandoff = (accept: boolean) => {
    void window.mimiCompanion
      .handoff(accept)
      .catch(() => setError(t("pet.companion.chatUnavailable")));
    if (!accept) interaction("leave");
  };
  return (
    <div
      className={reducedMotion ? "mimi-scene mimi-scene--still" : "mimi-scene"}
      aria-hidden={!visible}
      style={{ visibility: visible ? "visible" : "hidden" }}
    >
      {targetEffect && state.target && (
        <div
          key={state.activity.id}
          className={`mimi-target mimi-target--${state.activity.action}`}
          style={{ left: state.target.x, top: state.target.y }}
        >
          {state.activity.action === "scroll" && <span>↕</span>}
          {impact === state.activity.id && <span className="mimi-impact" />}
        </div>
      )}
      <div
        className={`mimi-companion${held ? " mimi-companion--held" : ""}${travel.kind === "hop" ? " mimi-companion--hop" : ""}${travel.kind === "walk" && !reducedMotion ? ` mimi-companion--dash-${travel.facing}` : ""}${yielding ? " mimi-companion--yield" : ""}`}
        data-appearance={state.appearance}
        data-action={cueActive ? presented.activity.action : "idle"}
        data-perch={state.perch ?? "beside-target"}
        data-travel={travel.kind}
        style={{
          width: Math.round(state.size * 0.7),
          height: state.size,
          transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
          transition:
            held || state.avoidInput || travel.kind === "hop"
              ? "none"
              : travel.kind === "walk"
                ? `transform ${travel.duration}ms ${pace === "fly" ? "cubic-bezier(0.34, 1.3, 0.64, 1)" : "cubic-bezier(0.33, 0.8, 0.4, 1)"}, width ${travel.duration}ms, height ${travel.duration}ms`
                : reducedMotion
                  ? undefined
                  : "transform 280ms ease-out, width 180ms, height 180ms",
        }}
      >
        <button
          ref={body}
          type="button"
          className="mimi-companion__body"
          aria-label={t("pet.companion.bodyLabel")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onPointerEnter={() => {
            setHovered(true);
            lastHoverAt.current = performance.now();
            interaction("hover");
          }}
          onPointerLeave={() => {
            setHovered(false);
            if (!gesture.current && !menuOpen) interaction("leave");
          }}
          onFocus={() => {
            setHovered(true);
            interaction("hover");
          }}
          onBlur={() => {
            setHovered(false);
            if (!gesture.current && !menuOpen) interaction("leave");
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const origin = state.windowOrigin ?? { x: 0, y: 0 };
            // Capture the visible position even if a follow transition is still in flight.
            const bounds = event.currentTarget.getBoundingClientRect();
            gesture.current = {
              pointerId: event.pointerId,
              target: event.currentTarget,
              startX: event.screenX,
              startY: event.screenY,
              lastX: event.screenX,
              origin: { x: origin.x + bounds.left, y: origin.y + bounds.top },
              dragged: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragPosition({ x: bounds.left, y: bounds.top });
            setHeld(true);
            setMenuOpen(false);
            interaction("begin");
          }}
          onPointerMove={(event) => {
            const current = gesture.current;
            if (!current) {
              if (hoverNeedsRefresh.current || performance.now() - lastHoverAt.current > 160) {
                lastHoverAt.current = performance.now();
                hoverNeedsRefresh.current = false;
                setHovered(true);
                interaction("hover");
              }
              return;
            }
            if (current.pointerId !== event.pointerId) return;
            if ((event.buttons & 1) === 0) {
              finishGesture(event, true);
              return;
            }
            const dx = event.screenX - current.startX;
            const dy = event.screenY - current.startY;
            if (!current.dragged && Math.hypot(dx, dy) < 4) return;
            current.dragged = true;
            setMoving(event.screenX < current.lastX ? "left" : "right");
            current.lastX = event.screenX;
            const globalPosition = { x: current.origin.x + dx, y: current.origin.y + dy };
            const origin = state.windowOrigin ?? { x: 0, y: 0 };
            setDragPosition({ x: globalPosition.x - origin.x, y: globalPosition.y - origin.y });
            window.mimiCompanion.move(globalPosition);
          }}
          onPointerUp={(event) => finishGesture(event, false)}
          onPointerCancel={(event) => finishGesture(event, true)}
          onLostPointerCapture={(event) => finishGesture(event, true)}
          onClick={(event) => {
            if (event.detail === 0) {
              interaction("begin");
              openChat();
              interaction("end");
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuOpen(true);
            interaction("begin");
          }}
        >
          <Actor
            state={presented}
            reducedMotion={reducedMotion}
            moving={moving ?? (travel.kind === "walk" ? travel.facing : null)}
            cueActive={cueActive}
            onReady={ready}
            onError={failed}
            onContact={() => {
              setImpact(presented.activity.id);
              window.clearTimeout(impactTimer.current);
              impactTimer.current = window.setTimeout(() => setImpact(null), 320);
            }}
          />
        </button>
        {/* Sitting on the field, the paws already type; the field is the keyboard. */}
        {typing && state.perch !== "on-field" && (
          <div
            className={`mimi-keyboard${presented.activity.phase === "end" ? " mimi-keyboard--settling" : ""}`}
            aria-label={t("pet.companion.cueLabel")}
          >
            {Array.from({ length: 12 }, (_, index) => (
              <i key={index} style={{ animationDelay: `${-index * 90}ms` }} />
            ))}
          </div>
        )}
        {state.preview && (
          <div className="mimi-companion__preview">{t("pet.companion.preview")}</div>
        )}
        {(error || cueActive || state.control?.stopped) && (
          <div
            className="mimi-companion__activity"
            role="status"
            data-notice={error || state.control?.stopped ? "true" : undefined}
          >
            {error ??
              (state.control?.stopped && !cueActive
                ? t("pet.companion.computerStopped")
                : undefined) ??
              (presented.activity.action === "type"
                ? presented.activity.phase === "start"
                  ? t("pet.companion.typing")
                  : t("pet.companion.typed")
                : companionActionLabel(presented))}
          </div>
        )}
        {showAttention && attention && (
          <button
            type="button"
            className="mimi-companion__badge"
            data-attention={
              attention.needsAction > 0
                ? "needs-action"
                : attention.unread > 0
                  ? "unread"
                  : "running"
            }
            aria-label={
              attentionCount > 0
                ? t("pet.companion.attentionCount", { count: attentionCount })
                : t("pet.companion.attentionNone")
            }
            onPointerEnter={() => interaction("hover")}
            onPointerLeave={() => interaction("leave")}
            onClick={() => {
              void window.mimiCompanion
                .openActivity()
                .catch(() => setError(t("pet.companion.activityUnavailable")));
            }}
          >
            {attentionCount > 0 ? (attentionCount > 99 ? "99+" : attentionCount) : null}
          </button>
        )}
        {state.handoff && !menuOpen && !held && (
          <div
            className="mimi-companion__handoff"
            role="dialog"
            aria-label={t("pet.companion.handoffLabel", {
              name: spriteCharacter(state.appearance).name,
            })}
            onPointerEnter={() => interaction("hover")}
            onPointerLeave={() => interaction("leave")}
          >
            <p>
              {t("pet.companion.handoffPrompt", {
                name: spriteCharacter(state.appearance).name,
                app: state.handoff.app,
              })}
            </p>
            <div>
              <button type="button" onClick={() => answerHandoff(true)}>
                {t("pet.companion.handoffAccept")}
              </button>
              <button type="button" onClick={() => answerHandoff(false)}>
                {t("pet.companion.handoffDecline")}
              </button>
            </div>
          </div>
        )}
        {menuOpen && (
          <div
            ref={menu}
            className="mimi-companion__menu"
            role="menu"
            aria-label={t("pet.companion.menuLabel")}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                window.mimiCompanion.resumeFollowing();
                closeMenu();
              }}
            >
              {t("pet.companion.resumeFollowing")}
            </button>
            <button
              type="button"
              role="menuitem"
              data-mimi-presence="dock"
              onClick={() => {
                window.mimiCompanion.presence("dock");
                closeMenu();
              }}
            >
              {t("pet.companion.dock")}
            </button>
            <div
              className="mimi-companion__sizes"
              role="group"
              aria-label={t("pet.companion.sizes")}
            >
              {MIMI_COMPANION_QUICK_SIZES.map((option) => (
                <button
                  key={option.size}
                  type="button"
                  role="menuitemradio"
                  aria-checked={(state.chosenSize ?? state.size) === option.size}
                  aria-label={t("pet.companion.sizeAria", {
                    name: t(`pet.companion.size.${option.name}`),
                    size: option.size,
                  })}
                  onClick={() => {
                    window.mimiCompanion.resize(option.size);
                    closeMenu();
                  }}
                >
                  {t(`pet.companion.size.${option.name}`)}
                </button>
              ))}
            </div>
            {state.control?.stopped || state.control?.foregroundHeld ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  window.mimiCompanion.resumeComputer();
                  closeMenu();
                }}
              >
                {t("pet.companion.resumeComputer")}
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  window.mimiCompanion.stopComputer();
                  closeMenu();
                }}
              >
                {t("pet.companion.stopComputer")}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              data-mimi-presence="close"
              onClick={() => {
                window.mimiCompanion.presence("close");
                closeMenu();
              }}
            >
              {t("pet.companion.close")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
