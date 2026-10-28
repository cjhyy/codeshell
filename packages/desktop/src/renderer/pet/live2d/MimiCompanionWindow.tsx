import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { MimiCompanionApi, MimiCompanionState } from "../../../shared/mimi-companion";
import type { CharacterRenderer } from "./character-renderer";
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
  "mimi-sprite": { id: "mimi-sprite", label: "Mimi 动画集", Actor: SpriteActor },
  live2d: { id: "live2d", label: "Live2D 示例", Actor: Live2DActor },
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
  const [cueId, setCueId] = useState<string | null>(null);
  const seenActivities = useRef(new Set<string>());
  const gesture = useRef<Gesture | null>(null);
  const lastHoverAt = useRef(0);
  const hoverNeedsRefresh = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
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
      if (gesture.current) {
        window.mimiCompanion.interaction("end");
        window.mimiCompanion.interaction("leave");
      }
    };
  }, []);

  useEffect(() => {
    setCueId(null);
    if (!state) return;
    const id = state.activity.id;
    if (seenActivities.current.has(id)) return;
    seenActivities.current.add(id);
    if (seenActivities.current.size > 64)
      seenActivities.current.delete(seenActivities.current.values().next().value!);
    if (humanActive || !visible) return;
    const remaining =
      companionCueDuration(state) - Math.max(0, Date.now() - state.activity.startedAt);
    if (remaining <= 0) return;
    setCueId(id);
    const timer = window.setTimeout(() => setCueId(null), remaining);
    return () => window.clearTimeout(timer);
  }, [state?.activity.id, humanActive, visible]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    window.mimiCompanion.interaction("end");
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) closeMenu();
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
  const { Actor } = CHARACTER_RENDERERS[state.appearance] ?? CHARACTER_RENDERERS["mimi-sprite"];
  const cueActive = cueId === state.activity.id && !humanActive;
  const typing = cueActive && (state.activity.action === "type" || state.activity.action === "key");
  const targetEffect = cueActive && ["click", "scroll", "drag"].includes(state.activity.action);
  const position = dragPosition ?? state.position;
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
        className={`mimi-companion${held ? " mimi-companion--held" : ""}`}
        data-appearance={state.appearance}
        data-action={cueActive ? state.activity.action : "idle"}
        style={{
          width: Math.round(state.size * 0.7),
          height: state.size,
          transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        }}
      >
        <button
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
            gesture.current = {
              pointerId: event.pointerId,
              startX: event.screenX,
              startY: event.screenY,
              lastX: event.screenX,
              origin: { x: origin.x + position.x, y: origin.y + position.y },
              dragged: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
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
              state={state}
              reducedMotion={reducedMotion}
              moving={moving}
              cueActive={cueActive}
              onReady={ready}
              onError={failed}
            />
          </Suspense>
        </button>
        {typing && (
          <div className="mimi-keyboard" aria-label="输入动作提示">
            {Array.from({ length: 12 }, (_, index) => (
              <i key={index} style={{ animationDelay: `${index * 25}ms` }} />
            ))}
          </div>
        )}
        {state.preview && <div className="mimi-companion__preview">动作预览</div>}
        {(error || cueActive) && (
          <div className="mimi-companion__activity" role="status">
            {error ?? companionActionLabel(state)}
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
          </div>
        )}
      </div>
    </div>
  );
}
