import React, { useEffect, useRef, useState } from "react";
import atlas from "../../assets/mimi-papillon/spritesheet-v2.webp";
import type { CharacterActorProps } from "./character-renderer";
import { SPRITE_ANIMATIONS, spriteAnimation } from "./sprite-animation";

export function SpriteActor({
  state,
  reducedMotion,
  moving,
  cueActive,
  onReady,
  onError,
}: CharacterActorProps) {
  const [frame, setFrame] = useState(0);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const animation = spriteAnimation(state, moving, cueActive);
  const { row, frames } = SPRITE_ANIMATIONS[animation];
  const typing = animation === "typing";
  const gestureId = typing ? undefined : state.activity.id;
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
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, []);

  useEffect(() => {
    setFrame(0);
    if (!playing) return;
    const timer = window.setInterval(
      () =>
        setFrame((value) =>
          moving || typing ? (value + 1) % frames : Math.min(value + 1, frames - 1),
        ),
      typing ? 260 : 100,
    );
    return () => window.clearInterval(timer);
  }, [animation, frames, playing, moving, typing, gestureId]);

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
        backgroundImage: `url(${atlas})`,
        backgroundPosition: `${((reducedMotion || animation === "idle" ? 0 : column) / 7) * 100}% ${(row / 10) * 100}%`,
      }}
    />
  );
}
