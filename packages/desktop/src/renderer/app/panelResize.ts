interface PanelResizeOptions {
  startX: number;
  startWidth: number;
  target: HTMLElement;
  minWidth: number;
  maxWidth: () => number;
  onCommit: (width: number) => void;
  onFinish?: () => void;
}

/** Clamp one right-dock resize sample to the current window constraints. */
export function resizedPanelWidth(
  startX: number,
  currentX: number,
  startWidth: number,
  minWidth: number,
  maxWidth: number,
): number {
  const delta = startX - currentX;
  return Math.min(Math.max(minWidth, maxWidth), Math.max(minWidth, startWidth + delta));
}

/**
 * Keep a dock resize in the host renderer even when the pointer crosses an
 * Electron webview. The shield owns subsequent mouse events, while the dock's
 * inline width is previewed directly so the whole React app does not rerender
 * for every raw mouse sample. React state is committed once at the end.
 */
export function startPanelResize({
  startX,
  startWidth,
  target,
  minWidth,
  maxWidth,
  onCommit,
  onFinish,
}: PanelResizeOptions): () => void {
  const ownerDocument = target.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return () => undefined;

  const shield = ownerDocument.createElement("div");
  shield.setAttribute("data-panel-resize-shield", "true");
  shield.setAttribute("aria-hidden", "true");
  shield.style.position = "fixed";
  shield.style.inset = "0";
  shield.style.zIndex = "2147483647";
  shield.style.cursor = "col-resize";
  shield.style.userSelect = "none";
  shield.style.touchAction = "none";
  shield.style.pointerEvents = "auto";
  shield.style.background = "transparent";

  // Electron guests can otherwise take mouse ownership away from the host
  // renderer mid-drag. Restore their previous inline values verbatim.
  const guests = Array.from(target.querySelectorAll<HTMLElement>("webview"));
  const guestPointerEvents = guests.map((guest) => guest.style.pointerEvents);
  guests.forEach((guest) => {
    guest.style.pointerEvents = "none";
  });

  const previousUserSelect = ownerDocument.body.style.userSelect;
  const previousCursor = ownerDocument.body.style.cursor;
  ownerDocument.body.style.userSelect = "none";
  ownerDocument.body.style.cursor = "col-resize";
  ownerDocument.body.appendChild(shield);

  const hasAnimationFrame = typeof ownerWindow.requestAnimationFrame === "function";
  const requestFrame = (callback: FrameRequestCallback): number =>
    hasAnimationFrame
      ? ownerWindow.requestAnimationFrame(callback)
      : ownerWindow.setTimeout(() => callback(ownerWindow.performance.now()), 16);
  const cancelFrame = (id: number): void => {
    if (hasAnimationFrame) ownerWindow.cancelAnimationFrame(id);
    else ownerWindow.clearTimeout(id);
  };

  let disposed = false;
  let pendingWidth = startWidth;
  let frameId: number | null = null;

  const applyPreview = (): void => {
    frameId = null;
    target.style.width = `${pendingWidth}px`;
  };
  const preview = (currentX: number): void => {
    pendingWidth = resizedPanelWidth(startX, currentX, startWidth, minWidth, maxWidth());
    if (frameId === null) frameId = requestFrame(applyPreview);
  };
  const flushPreview = (): void => {
    if (frameId !== null) cancelFrame(frameId);
    frameId = null;
    target.style.width = `${pendingWidth}px`;
  };
  const finish = (commit: boolean): void => {
    if (disposed) return;
    disposed = true;
    if (commit) {
      flushPreview();
    } else {
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
      target.style.width = `${startWidth}px`;
    }
    shield.removeEventListener("mousemove", onMove);
    shield.removeEventListener("mouseup", onUp);
    ownerWindow.removeEventListener("mouseup", onUp);
    ownerWindow.removeEventListener("blur", onAbort);
    ownerWindow.removeEventListener("pointercancel", onAbort);
    ownerWindow.removeEventListener("keydown", onKeyDown);
    if (shield.parentNode) shield.parentNode.removeChild(shield);
    ownerDocument.body.style.userSelect = previousUserSelect;
    ownerDocument.body.style.cursor = previousCursor;
    guests.forEach((guest, index) => {
      guest.style.pointerEvents = guestPointerEvents[index] ?? "";
    });
    if (commit) onCommit(pendingWidth);
    onFinish?.();
  };
  const onMove = (event: MouseEvent): void => preview(event.clientX);
  const onUp = (event: MouseEvent): void => {
    if (Number.isFinite(event.clientX)) preview(event.clientX);
    finish(true);
  };
  const onAbort = (): void => finish(true);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") finish(false);
  };

  shield.addEventListener("mousemove", onMove);
  shield.addEventListener("mouseup", onUp);
  ownerWindow.addEventListener("mouseup", onUp);
  ownerWindow.addEventListener("blur", onAbort);
  ownerWindow.addEventListener("pointercancel", onAbort);
  ownerWindow.addEventListener("keydown", onKeyDown);

  return () => finish(false);
}
