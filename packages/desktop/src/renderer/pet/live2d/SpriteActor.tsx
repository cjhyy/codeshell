import React, { useEffect, useRef, useState } from "react";
import atlas from "../../assets/mimi-papillon/spritesheet-v2.webp";
import performerAtlas from "../../assets/mimi-papillon/performer-v1.webp";
import { COMPANION_SPRITE_BOTTOM } from "../../../shared/mimi-companion";
import { BUNDLED_PACK } from "./bundled-pack";
import { packFacesLeft, packFrameStyle, packMove } from "./character-pack";
import type { CharacterActorProps } from "./character-renderer";
import { SPRITE_ANIMATIONS, spriteAnimation } from "./sprite-animation";

export function SpriteActor({
  state,
  reducedMotion,
  moving,
  cueActive,
  onReady,
  onError,
  onContact,
}: CharacterActorProps) {
  const [frame, setFrame] = useState(0);
  const callbacks = useRef({ onReady, onError, onContact });
  callbacks.current = { onReady, onError, onContact };
  const moveName = packMove(BUNDLED_PACK, state, cueActive, moving);
  const move = moveName ? BUNDLED_PACK.moves[moveName] : undefined;
  const animation = spriteAnimation(state, moving, cueActive);
  const { row } = SPRITE_ANIMATIONS[animation];
  const frames = move?.frames ?? SPRITE_ANIMATIONS[animation].frames;
  const typing = !move && animation === "typing";
  const looping = move ? move.loop : Boolean(moving) || typing;
  const interval = move?.frameMs ?? (typing ? 260 : 100);
  const gestureId = looping ? undefined : state.activity.id;
  const playing =
    (state.enabled || state.preview) &&
    state.visible &&
    !reducedMotion &&
    (cueActive || Boolean(moving));

  useEffect(() => {
    const image = new Image();
    image.onload = () => callbacks.current.onReady();
    image.onerror = () => callbacks.current.onError("Mimi 动画资源加载失败");
    image.src = atlas;
    // Warm the performer atlas so the first surface move does not flash.
    new Image().src = performerAtlas;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, []);

  useEffect(() => {
    setFrame(0);
    if (!playing) return;
    const timer = window.setInterval(
      () => setFrame((value) => (looping ? (value + 1) % frames : Math.min(value + 1, frames - 1))),
      interval,
    );
    return () => window.clearInterval(timer);
  }, [animation, moveName, frames, playing, looping, interval, gestureId]);

  useEffect(() => {
    if (playing && move?.contact !== undefined && frame === move.contact)
      callbacks.current.onContact?.();
  }, [frame, move, playing]);

  if (move) {
    return (
      <div
        className="mimi-companion__sprite"
        role="img"
        aria-label="Mimi，全身动画角色"
        data-animation={moveName}
        style={{
          bottom: COMPANION_SPRITE_BOTTOM,
          backgroundImage: `url(${performerAtlas})`,
          ...packFrameStyle(BUNDLED_PACK, move, reducedMotion ? 0 : frame, packFacesLeft(state)),
        }}
      />
    );
  }

  // Reuse the small paw lift, alternating its middle poses instead of cycling
  // the full-body working atlas row. No transform moves the whole character.
  const column = typing ? [0, 1, 2, 1][frame % frames] : frame % frames;

  return (
    <div
      className="mimi-companion__sprite"
      role="img"
      aria-label="Mimi，全身动画角色"
      data-animation={animation}
      style={{
        bottom: COMPANION_SPRITE_BOTTOM,
        backgroundImage: `url(${atlas})`,
        backgroundPosition: `${((reducedMotion || animation === "idle" ? 0 : column) / 7) * 100}% ${(row / 10) * 100}%`,
      }}
    />
  );
}
