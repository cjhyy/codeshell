import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { MimiCompanionApi, MimiCompanionState } from "../../../shared/mimi-companion";
import type { CharacterRenderer } from "./character-renderer";
import { companionActionLabel } from "./companion-pose";
import { SpriteActor } from "./SpriteActor";
import "./companion.css";

declare global {
  interface Window {
    mimiCompanion: MimiCompanionApi;
  }
}

// Optional adapters stay out of the default renderer's startup path.
const Live2DActor = lazy(() => import("./Live2DActor"));
export const CHARACTER_RENDERERS: Record<MimiCompanionState["appearance"], CharacterRenderer> = {
  "mimi-sprite": { id: "mimi-sprite", label: "Mimi 动画集", Actor: SpriteActor },
  live2d: { id: "live2d", label: "Live2D 示例", Actor: Live2DActor },
};

export function MimiCompanionWindow() {
  const [state, setState] = useState<MimiCompanionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<"left" | "right" | null>(null);
  const previousPosition = useRef<MimiCompanionState["position"] | null>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
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
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    const previous = previousPosition.current;
    previousPosition.current = state.position;
    if (reducedMotion || !previous) {
      setMoving(null);
      return;
    }
    if (Math.hypot(state.position.x - previous.x, state.position.y - previous.y) < 8) {
      setMoving(null);
      return;
    }
    setMoving(state.position.x < previous.x ? "left" : "right");
    const timer = window.setTimeout(() => setMoving(null), 320);
    return () => window.clearTimeout(timer);
  }, [state?.position.x, state?.position.y, reducedMotion]);

  const ready = useCallback(() => {
    setError(null);
    window.mimiCompanion.ready();
  }, []);
  const failed = useCallback((message: string) => {
    setError(message);
    window.mimiCompanion.ready({ error: message });
  }, []);

  if (!state) return null;
  const { Actor } = CHARACTER_RENDERERS[state.appearance] ?? CHARACTER_RENDERERS["mimi-sprite"];
  const visible = (state.enabled || state.preview) && state.visible;
  const active = state.activity.action !== "idle";
  const typing = active && (state.activity.action === "type" || state.activity.action === "key");
  const targetEffect = active && ["click", "scroll", "drag"].includes(state.activity.action);
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
        className="mimi-companion"
        data-appearance={state.appearance}
        data-action={state.activity.action}
        style={{
          width: Math.round(state.size * 0.7),
          height: state.size,
          transform: `translate3d(${state.position.x}px, ${state.position.y}px, 0)`,
        }}
      >
        <Suspense fallback={null}>
          <Actor
            state={state}
            reducedMotion={reducedMotion}
            moving={moving}
            onReady={ready}
            onError={failed}
          />
        </Suspense>
        {typing && (
          <div className="mimi-keyboard" aria-label="输入动作提示">
            {Array.from({ length: 12 }, (_, index) => (
              <i key={index} style={{ animationDelay: `${index * 70}ms` }} />
            ))}
          </div>
        )}
        {state.preview && <div className="mimi-companion__preview">动作预览</div>}
        <div className="mimi-companion__activity" role="status">
          {error ?? companionActionLabel(state)}
        </div>
      </div>
    </div>
  );
}
