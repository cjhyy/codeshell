import React, { useEffect, useRef, useState } from "react";
import { COMPANION_SPRITE_BOTTOM } from "../../../shared/mimi-companion";
import { packFacesLeft, packFrameStyle, packMove } from "./character-pack";
import type { CharacterActorProps } from "./character-renderer";
import { SPRITE_ANIMATIONS, spriteAnimation } from "./sprite-animation";
import { spriteCharacter } from "./sprite-characters";

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
  const character = spriteCharacter(state.appearance);
  const { atlas, performer } = character;
  const moveName = performer && packMove(performer.pack, state, cueActive, moving);
  const move = moveName ? performer.pack.moves[moveName] : undefined;
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
    image.onerror = () => callbacks.current.onError(`${character.name} 动画资源加载失败`);
    image.src = atlas;
    // Warm the performer atlas so the first surface move does not flash.
    if (performer) new Image().src = performer.atlas;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [character, atlas, performer]);

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

  if (move && performer) {
    return (
      <div
        className="mimi-companion__sprite"
        role="img"
        aria-label={`${character.name}，全身动画角色`}
        data-animation={moveName}
        style={{
          bottom: COMPANION_SPRITE_BOTTOM,
          backgroundImage: `url(${performer.atlas})`,
          ...packFrameStyle(performer.pack, move, reducedMotion ? 0 : frame, packFacesLeft(state)),
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
      aria-label={`${character.name}，全身动画角色`}
      data-animation={animation}
      style={{
        bottom: COMPANION_SPRITE_BOTTOM,
        backgroundImage: `url(${atlas})`,
        backgroundPosition: `${((reducedMotion || animation === "idle" ? 0 : column) / 7) * 100}% ${(row / 10) * 100}%`,
      }}
    />
  );
}
