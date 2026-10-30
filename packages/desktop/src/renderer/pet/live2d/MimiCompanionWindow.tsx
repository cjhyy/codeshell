import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { MimiCompanionApi, MimiCompanionState } from "../../../shared/mimi-companion";
import {
  effectAction,
  LIVE2D_EFFECTS,
  SPRITE_EFFECTS,
  type CharacterRenderer,
} from "./character-renderer";
import { companionLocomotion, HOP_MS, type CompanionLocomotion } from "./companion-locomotion";
import { companionActionLabel } from "./companion-pose";
import { companionCueDuration } from "./sprite-animation";
import { SpriteActor } from "./SpriteActor";
import "./companion.css";

declare global {
  interface Window {
    mimiCompanion: MimiCompanionApi;
  }
}
const Live2DActor = lazy(() => import("./Live2DActor"));
export const CHARACTER_RENDERERS: Record<MimiCompanionState["appearance"], CharacterRenderer> = {
  "mimi-sprite": {
    id: "mimi-sprite",
    label: "Mimi 动画集",
    Actor: SpriteActor,
    effects: SPRITE_EFFECTS,
  },
  live2d: { id: "live2d", label: "Live2D 示例", Actor: Live2DActor, effects: LIVE2D_EFFECTS },
};

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: { x: number; y: number };
  lastX: number;
  dragged: boolean;
};

export function MimiCompanionWindow() {
  const [state, setState] = useState<MimiCompanionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<"left" | "right" | null>(null);
  const [hovered, setHovered] = useState(false);
  const [held, setHeld] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const [travel, setTravel] = useState<CompanionLocomotion>({ kind: "none" });
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
          setError("无法读取角色状态");
          window.mimiCompanion.ready({ error: "无法读取角色状态" });
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
      if (gesture.current) {
        window.mimiCompanion.interaction("end");
        window.mimiCompanion.interaction("leave");
      }
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
    window.mimiCompanion.interaction("end");
    // Closing a menu outside the body must release the native mouse capture.
    // `end` alone deliberately keeps an ordinary body click interactive.
    if (!body.current?.matches(":hover")) {
      setHovered(false);
      window.mimiCompanion.interaction("leave");
    }
  }, []);
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
  const openChat = () => {
    hoverNeedsRefresh.current = true;
    void window.mimiCompanion.openChat().then(
      () => {
        hoverNeedsRefresh.current = true;
      },
      () => setError("暂时无法打开聊天"),
    );
  };
  const finishGesture = (event: React.PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setHeld(false);
    setMoving(null);
    setDragPosition(null);
    window.mimiCompanion.interaction("end");
    if (cancelled) {
      setHovered(false);
      window.mimiCompanion.interaction("leave");
    }
    if (!cancelled && !current.dragged) openChat();
  };

  if (!state) return null;
  const { Actor, effects } =
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
  // While the human is typing or pointing elsewhere, step back and go quiet.
  const yielding = Boolean(state.control?.userActive) && !humanActive;
  const answerHandoff = (accept: boolean) => {
    void window.mimiCompanion.handoff(accept).catch(() => setError("暂时无法打开聊天"));
    if (!accept) window.mimiCompanion.interaction("leave");
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
        </div>
      )}
      <div
        className={`mimi-companion${held ? " mimi-companion--held" : ""}${travel.kind === "hop" ? " mimi-companion--hop" : ""}${yielding ? " mimi-companion--yield" : ""}`}
        data-appearance={state.appearance}
        data-action={cueActive ? presented.activity.action : "idle"}
        data-perch={state.perch ?? "beside-target"}
        data-travel={travel.kind}
        style={{
          width: Math.round(state.size * 0.7),
          height: state.size,
          transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
          transition:
            state.avoidInput || travel.kind === "hop"
              ? "none"
              : travel.kind === "walk"
                ? `transform ${travel.duration}ms cubic-bezier(0.33, 0.8, 0.4, 1), width ${travel.duration}ms, height ${travel.duration}ms`
                : reducedMotion
                  ? undefined
                  : "transform 280ms ease-out, width 180ms, height 180ms",
        }}
      >
        <button
          ref={body}
          type="button"
          className="mimi-companion__body"
          aria-label="打开 Mimi 聊天，拖动可移动"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onPointerEnter={() => {
            setHovered(true);
            lastHoverAt.current = performance.now();
            window.mimiCompanion.interaction("hover");
          }}
          onPointerLeave={() => {
            setHovered(false);
            if (!gesture.current && !menuOpen) window.mimiCompanion.interaction("leave");
          }}
          onFocus={() => {
            setHovered(true);
            window.mimiCompanion.interaction("hover");
          }}
          onBlur={() => {
            setHovered(false);
            if (!gesture.current && !menuOpen) window.mimiCompanion.interaction("leave");
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const origin = state.windowOrigin ?? { x: 0, y: 0 };
            // Capture the visible position even if a follow transition is still in flight.
            const bounds = event.currentTarget.getBoundingClientRect();
            gesture.current = {
              pointerId: event.pointerId,
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
            window.mimiCompanion.interaction("begin");
          }}
          onPointerMove={(event) => {
            const current = gesture.current;
            if (!current) {
              if (hoverNeedsRefresh.current || performance.now() - lastHoverAt.current > 160) {
                lastHoverAt.current = performance.now();
                hoverNeedsRefresh.current = false;
                setHovered(true);
                window.mimiCompanion.interaction("hover");
              }
              return;
            }
            if (current.pointerId !== event.pointerId) return;
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
              window.mimiCompanion.interaction("begin");
              openChat();
              window.mimiCompanion.interaction("end");
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuOpen(true);
            window.mimiCompanion.interaction("begin");
          }}
        >
          <Suspense fallback={null}>
            <Actor
              state={presented}
              reducedMotion={reducedMotion}
              moving={moving ?? (travel.kind === "walk" ? travel.facing : null)}
              cueActive={cueActive}
              onReady={ready}
              onError={failed}
            />
          </Suspense>
        </button>
        {typing && (
          <div
            className={`mimi-keyboard${presented.activity.phase === "end" ? " mimi-keyboard--settling" : ""}`}
            aria-label="输入动作提示"
          >
            {Array.from({ length: 12 }, (_, index) => (
              <i key={index} style={{ animationDelay: `${-index * 90}ms` }} />
            ))}
          </div>
        )}
        {state.preview && <div className="mimi-companion__preview">动作预览</div>}
        {(error || cueActive || state.control?.stopped) && (
          <div className="mimi-companion__activity" role="status">
            {error ??
              (state.control?.stopped && !cueActive ? "已停止电脑操作" : undefined) ??
              (presented.activity.action === "type"
                ? presented.activity.phase === "start"
                  ? "正在输入"
                  : "输入完成"
                : companionActionLabel(presented))}
          </div>
        )}
        {state.handoff && !menuOpen && !held && (
          <div
            className="mimi-companion__handoff"
            role="dialog"
            aria-label="让 Mimi 看看这个窗口"
            onPointerEnter={() => window.mimiCompanion.interaction("hover")}
            onPointerLeave={() => window.mimiCompanion.interaction("leave")}
          >
            <p>让 Mimi 看看「{state.handoff.app}」？</p>
            <div>
              <button type="button" onClick={() => answerHandoff(true)}>
                看看
              </button>
              <button type="button" onClick={() => answerHandoff(false)}>
                算了
              </button>
            </div>
          </div>
        )}
        {menuOpen && (
          <div ref={menu} className="mimi-companion__menu" role="menu" aria-label="Mimi 选项">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                window.mimiCompanion.resumeFollowing();
                closeMenu();
              }}
            >
              恢复跟随工作
            </button>
            {state.control?.stopped || state.control?.foregroundHeld ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  window.mimiCompanion.resumeComputer();
                  closeMenu();
                }}
              >
                继续电脑操作
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
                停止电脑操作（⌘⇧Esc）
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
