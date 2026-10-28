import React, { useEffect, useRef, useState } from "react";
import atlas from "../../assets/mimi-papillon/spritesheet-v2.webp";
import type { CharacterActorProps } from "./character-renderer";
import { SPRITE_ANIMATIONS, spriteAnimation } from "./sprite-animation";

export function SpriteActor({
  state,
  reducedMotion,
  moving,
  onReady,
  onError,
}: CharacterActorProps) {
  const [frame, setFrame] = useState(0);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const animation = spriteAnimation(state, moving);
  const { row, frames } = SPRITE_ANIMATIONS[animation];
  const playing = (state.enabled || state.preview) && state.visible && !reducedMotion;

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
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % frames), 120);
    return () => window.clearInterval(timer);
  }, [animation, frames, playing, state.activity.id]);

  return (
    <div
      className="mimi-companion__sprite"
      role="img"
      aria-label="Mimi，全身动画角色"
      data-animation={animation}
      style={{
        backgroundImage: `url(${atlas})`,
        backgroundPosition: `${((reducedMotion ? 0 : frame % frames) / 7) * 100}% ${(row / 10) * 100}%`,
      }}
    />
  );
}
