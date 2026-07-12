import type { PetOpenSessionRequest } from "../../preload/types";
import React from "react";

export function PetActionChip({
  label,
  target,
  onOpen,
}: {
  label: string;
  target: PetOpenSessionRequest;
  onOpen: (target: PetOpenSessionRequest) => void;
}) {
  return (
    <button
      type="button"
      className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground hover:bg-muted"
      onClick={() => onOpen(target)}
    >
      {label}
    </button>
  );
}
