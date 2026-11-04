import React, { useEffect, useRef, useState } from "react";
import type { CharacterActorProps } from "./character-renderer";
import { poseBehavior, poseFacesLeft, poseLayout, posePick } from "./pose-library";
import { spriteCharacter } from "./sprite-characters";
import { SpriteActor } from "./SpriteActor";

/** Contact lands a beat after the pose appears, like a hit frame. */
const CONTACT_MS = 140;
const SFX_MS = 650;
/** At rest, a behavior pose every 12–28 s, held this long. */
const IDLE_GAP_MS = [12_000, 28_000] as const;
const IDLE_HOLD_MS = 3_600;
/** The pointer has to rest on her this long before she reacts. */
const HOVER_DWELL_MS = 450;

/**
 * The character's own behavior on top of the shared moments: an idle flourish
 * now and then while she stands at rest, and a reaction while the pointer
 * rests on her. Neither runs while she works, travels or with reduced motion.
 */
function useBehaviorPose(props: CharacterActorProps, resting: boolean): string | undefined {
  const { state, reducedMotion } = props;
  const library = spriteCharacter(state.appearance).poses?.library;
  const [idle, setIdle] = useState<string>();
  const [hover, setHover] = useState<string>();
  const hasIdle = Boolean(library?.behaviors?.idle?.length);
  const hasHover = Boolean(library?.behaviors?.hover?.length);

  useEffect(() => {
    setIdle(undefined);
    if (!library || !hasIdle || !resting || reducedMotion) return;
    let timer: number;
    const schedule = () => {
      const [min, max] = IDLE_GAP_MS;
      timer = window.setTimeout(
        () => {
          setIdle(poseBehavior(library, "idle", Math.random() * 1e6));
          timer = window.setTimeout(() => {
            setIdle(undefined);
            schedule();
          }, IDLE_HOLD_MS);
        },
        min + Math.random() * (max - min),
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [library, hasIdle, resting, reducedMotion]);

  const hovering = resting && Boolean(state.humanActive);
  useEffect(() => {
    setHover(undefined);
    if (!library || !hasHover || !hovering || reducedMotion) return;
    const timer = window.setTimeout(
      () => setHover(poseBehavior(library, "hover", Math.random() * 1e6)),
      HOVER_DWELL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [library, hasHover, hovering, reducedMotion]);

  return hover ?? idle;
}

/**
 * Key-pose actor: one large illustration per moment, popped in on change and
 * held, with a contact beat and a sound-effect word. A moment the library has
 * no pose for falls back to the character's base atlas.
 */
export function PoseActor(props: CharacterActorProps) {
  const { state, reducedMotion, moving, cueActive, onReady, onError, onContact } = props;
  const character = spriteCharacter(state.appearance);
  const poses = character.poses;
  const picked = poses && posePick(poses.library, state, cueActive, moving);
  // Her own flourishes replace only the plain standing pose.
  const behavior = useBehaviorPose(props, !cueActive && !moving && picked === "stand");
  const name = behavior ?? picked;
  const pose = name ? poses?.library.poses[name] : undefined;
  const [sfx, setSfx] = useState<{ id: string; text: string } | null>(null);
  const callbacks = useRef({ onReady, onError, onContact });
  callbacks.current = { onReady, onError, onContact };
  // A new pose, or the same pose for a new action, is a new beat.
  const beat = `${name ?? "sprite"}:${cueActive ? state.activity.id : "rest"}`;

  useEffect(() => {
    if (!poses) return;
    const urls = Object.values(poses.urls).filter((url): url is string => Boolean(url));
    let pending = urls.length;
    let failed = false;
    const images = urls.map((url) => {
      const image = new Image();
      image.onload = () => {
        if (--pending === 0 && !failed) callbacks.current.onReady();
      };
      image.onerror = () => {
        if (failed) return;
        failed = true;
        callbacks.current.onError(`${character.name} 姿势资源加载失败`);
      };
      image.src = url;
      return image;
    });
    return () => {
      for (const image of images) image.onload = image.onerror = null;
    };
  }, [poses, character.name]);

  useEffect(() => {
    setSfx(null);
    if (!pose || !(cueActive || behavior) || !pose.sfx) return;
    const text = pose.sfx;
    const id = beat;
    const contact = window.setTimeout(
      () => {
        callbacks.current.onContact?.();
        setSfx({ id, text });
      },
      reducedMotion ? 0 : CONTACT_MS,
    );
    const clear = window.setTimeout(() => setSfx(null), CONTACT_MS + SFX_MS);
    return () => {
      window.clearTimeout(contact);
      window.clearTimeout(clear);
    };
  }, [beat, pose, cueActive, behavior, reducedMotion]);

  if (!poses || !name || !pose) return <SpriteActor {...props} />;
  const layout = poseLayout(
    poses.library,
    pose,
    state,
    poseFacesLeft(state, moving),
    cueActive && state.activity.action === "click",
  );
  return (
    <div
      className="mimi-pose-stage"
      role="img"
      aria-label={`${character.name}，全身动画角色`}
      data-animation={name}
    >
      <div
        className={`mimi-pose-body${reducedMotion ? "" : ` mimi-pose-motion--${name}`}`}
        data-working={cueActive || undefined}
        // At rest the whole drawn pose is the character you hover, click and
        // drag (it sits inside the body button). While acting it stays
        // click-through: a pose drawn over a real control must not take its clicks.
        data-hit={(!cueActive && !moving) || undefined}
        style={
          {
            width: layout.width,
            height: layout.height,
            left: layout.left,
            bottom: layout.bottom,
            transformOrigin: layout.origin,
            "--mimi-pose-flip": layout.flip ? -1 : 1,
          } as React.CSSProperties
        }
      >
        <img
          key={reducedMotion ? name : beat}
          className={`mimi-pose${reducedMotion ? "" : " mimi-pose--pop"}`}
          src={poses.urls[name]}
          alt=""
          draggable={false}
          style={{ transformOrigin: layout.origin }}
        />
      </div>
      {sfx?.id === beat && (
        <span
          className="mimi-sfx"
          style={{
            left: layout.left + layout.width * 0.55,
            bottom: layout.bottom + layout.height * 0.7,
          }}
        >
          {sfx.text}
        </span>
      )}
    </div>
  );
}
