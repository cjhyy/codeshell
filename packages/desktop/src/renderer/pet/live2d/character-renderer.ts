import type { ComponentType } from "react";
import type { MimiCompanionState } from "../../../shared/mimi-companion";

/** One presentation contract for sprite, Live2D and future authored effect sets. */
export interface CharacterActorProps {
  state: MimiCompanionState;
  reducedMotion: boolean;
  moving: "left" | "right" | null;
  cueActive: boolean;
  onReady(): void;
  onError(message: string): void;
}

export interface CharacterRenderer {
  id: MimiCompanionState["appearance"];
  label: string;
  Actor: ComponentType<CharacterActorProps>;
}
