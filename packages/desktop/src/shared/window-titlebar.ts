/** Presentation-only updates for the main window's native caption buttons. */
export interface WindowTitleBarOverlay {
  symbolColor: string;
  /** Bottom edge of the visible header, in renderer CSS pixels (includes the frame). */
  height: number;
}
