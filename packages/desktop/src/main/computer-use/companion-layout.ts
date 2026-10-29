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
  avoidRect?: CompanionDisplayBounds,
): {
  position: { x: number; y: number };
  target?: { x: number; y: number };
  obstructed?: boolean;
} {
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
  const position = {
    x: clamp(left, display.width - width - 12),
    y: clamp(
      local ? local.y - height * 0.42 : display.height - height - 32,
      display.height - height - 32,
    ),
  };
  if (local && avoidRect) {
    const box = {
      x: avoidRect.x - display.x,
      y: avoidRect.y - display.y,
      width: avoidRect.width,
      height: avoidRect.height,
    };
    const gap = 24;
    const candidates = [
      { x: box.x - width - gap, y: position.y },
      { x: box.x + box.width + gap, y: position.y },
      { x: clamp(local.x - width / 2, display.width - width - 12), y: box.y + box.height + gap },
      { x: clamp(local.x - width / 2, display.width - width - 12), y: box.y - height - gap },
    ];
    const safe = candidates.find(
      (point) =>
        point.x >= 12 &&
        point.y >= 12 &&
        point.x + width <= display.width - 12 &&
        point.y + height <= display.height - 12 &&
        (point.x + width + gap <= box.x ||
          point.x >= box.x + box.width + gap ||
          point.y + height + gap <= box.y ||
          point.y >= box.y + box.height + gap),
    );
    // A full-screen editable surface can leave no free area. Temporarily hide
    // an automatically placed character rather than obscure its input.
    return { position: safe ?? position, target: local, ...(!safe ? { obstructed: true } : {}) };
  }
  return {
    position,
    ...(local ? { target: local } : {}),
  };
}
