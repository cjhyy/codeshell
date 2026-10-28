import React, { useEffect, useRef } from "react";
import type { Application } from "pixi.js";
import type { Cubism4InternalModel, Live2DModel } from "pixi-live2d-display/cubism4";
import type { CharacterActorProps } from "./character-renderer";
import { companionPose } from "./companion-pose";
import { loadCubismCore } from "./load-cubism-core";
interface Runtime {
  app: Application;
  model: Live2DModel<Cubism4InternalModel>;
  resize(size: number): void;
}

export default function Live2DActor({
  state,
  reducedMotion,
  onReady,
  onError,
}: CharacterActorProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef(state);
  const reduced = useRef(reducedMotion);
  const callbacks = useRef({ onReady, onError });
  const runtime = useRef<Runtime | null>(null);
  const activityClock = useRef({ id: "", startedAt: performance.now() });
  current.current = state;
  reduced.current = reducedMotion;
  callbacks.current = { onReady, onError };
  const { coreUrl, modelUrl } = state;
  useEffect(() => {
    if (!coreUrl || !modelUrl || !canvas.current) return;
    let disposed = false;
    let owned: Runtime | null = null;
    let pendingApp: Application | null = null;

    const load = async () => {
      if (modelUrl !== "csmimi://assets/Hiyori/Hiyori.model3.json") {
        throw new Error("Only the fixed local Hiyori prototype is supported.");
      }
      await loadCubismCore(coreUrl);
      const [PIXI, live2d] = await Promise.all([
        import("pixi.js"),
        import("pixi-live2d-display/cubism4"),
      ]);
      if (disposed || !canvas.current) return;
      const app = new PIXI.Application({
        view: canvas.current,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoStart: false,
        sharedTicker: false,
      });
      pendingApp = app;
      const model = (await live2d.Live2DModel.from(modelUrl, {
        autoUpdate: false,
        autoInteract: false,
        motionPreload: live2d.MotionPreloadStrategy.ALL,
      })) as Live2DModel<Cubism4InternalModel>;
      if (disposed) {
        model.destroy({ children: true, texture: true, baseTexture: true });
        app.destroy(false);
        pendingApp = null;
        return;
      }
      app.stage.addChild(model);
      model.anchor.set(0.5, 1);
      const nativeWidth = model.internalModel.originalWidth;
      const nativeHeight = model.internalModel.originalHeight;
      const resize = (height: number) => {
        const width = Math.round(height * 0.7);
        app.renderer.resize(width, height);
        const scale = Math.min((width - 8) / nativeWidth, (height - 8) / nativeHeight);
        model.scale.set(scale);
        model.position.set(width / 2, height - 4);
      };
      resize(current.current?.size ?? 320);
      const core = model.internalModel.coreModel;
      // Only known Hiyori parameters are changed, within the model's own limits.
      const ids = new Set(core.getModel().parameters.ids);
      const setParameter = (id: string, value: number) => {
        if (!ids.has(id)) return;
        const index = core.getParameterIndex(id);
        const bounded = Math.min(
          core.getParameterMaximumValue(index),
          Math.max(core.getParameterMinimumValue(index), value),
        );
        core.setParameterValueById(id, bounded);
      };
      model.internalModel.on("beforeModelUpdate", () => {
        const value = current.current;
        if (!value) return;
        if (activityClock.current.id !== value.activity.id) {
          activityClock.current = { id: value.activity.id, startedAt: performance.now() };
        }
        const pose = companionPose(
          value,
          performance.now() - activityClock.current.startedAt,
          reduced.current,
        );
        setParameter("ParamAngleX", pose.gazeX * 18);
        setParameter("ParamAngleY", pose.gazeY * 12);
        setParameter("ParamEyeBallX", pose.gazeX * 0.7);
        setParameter("ParamEyeBallY", pose.gazeY * 0.5);
        setParameter("ParamBodyAngleX", pose.gazeX * 4);
        setParameter("ParamBodyAngleZ", pose.bodyLean);
        if (pose.reach > 0 || pose.handPulse > 0) {
          setParameter("ParamArmRA", pose.reach + pose.handPulse);
          setParameter("ParamHandR", pose.handPulse);
        }
        if (pose.concerned > 0) {
          setParameter("ParamBrowLAngle", -pose.concerned);
          setParameter("ParamBrowRAngle", -pose.concerned);
        }
      });
      app.ticker.maxFPS = 30;
      app.ticker.add(() => model.update(Math.min(app.ticker.deltaMS, 100)));
      owned = { app, model, resize };
      runtime.current = owned;
      pendingApp = null;
      model.update(0);
      app.render();
      const latest = current.current;
      if ((latest.enabled || latest.preview) && latest.visible && !reduced.current) app.start();
      callbacks.current.onReady();
    };
    void load().catch(() => {
      pendingApp?.destroy(false);
      pendingApp = null;
      if (!disposed) {
        const message = "角色加载失败，请检查本地 Live2D 示例资源。";
        callbacks.current.onError(message);
      }
    });
    return () => {
      disposed = true;
      if (owned) {
        owned.model.destroy({ children: true, texture: true, baseTexture: true });
        owned.app.destroy(false);
        if (runtime.current === owned) runtime.current = null;
      }
    };
  }, [coreUrl, modelUrl]);

  useEffect(() => {
    const running = runtime.current;
    if (!running || !state) return;
    running.resize(state.size);
    if ((state.enabled || state.preview) && state.visible && !reducedMotion) {
      running.app.start();
    } else {
      running.app.stop();
      if ((state.enabled || state.preview) && state.visible) {
        running.model.update(0);
        running.app.render();
      }
    }
  }, [state, reducedMotion]);

  return <canvas ref={canvas} aria-label="Hiyori Momose，Live2D 示例角色" />;
}
