import { companionSize } from "../../shared/mimi-companion.js";

export interface CompanionDisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** CUA native AX bounds are global desktop logical points, not screenshot pixels. */
export function companionPlacement(
  display: CompanionDisplayBounds,
  size: number,
  target?: { x: number; y: number },
): { position: { x: number; y: number }; target?: { x: number; y: number } } {
  const height = companionSize(size);
  const width = height * 0.7;
  const local = target ? { x: target.x - display.x, y: target.y - display.y } : undefined;
  const clamp = (value: number, max: number) => Math.max(12, Math.min(Math.max(12, max), value));
  // Keep the character beside the target. The actor never covers the input point.
  const left = local
    ? local.x >= width + 40
      ? local.x - width - 24
      : local.x + 24
    : display.width - width - 24;
  return {
    position: {
      x: clamp(left, display.width - width - 12),
      y: clamp(
        local ? local.y - height * 0.42 : display.height - height - 32,
        display.height - height - 32,
      ),
    },
    ...(local ? { target: local } : {}),
  };
}
