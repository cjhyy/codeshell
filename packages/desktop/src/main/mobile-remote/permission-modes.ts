import type { PermissionMode } from "@cjhyy/code-shell-server/mobile-remote";

/** A phone choice stays authoritative until Desktop has adopted that choice. */
export class MobilePermissionModes extends Map<string, PermissionMode> {
  private readonly awaitingDesktop = new Map<string, PermissionMode>();

  override set(sessionId: string, mode: PermissionMode): this {
    if (this.get(sessionId) !== mode) this.awaitingDesktop.set(sessionId, mode);
    return super.set(sessionId, mode);
  }

  replaceDesktopSnapshot(raw: unknown): void {
    const next = new Map<string, PermissionMode>();
    for (const row of Array.isArray(raw) ? raw : []) {
      if (
        typeof row?.sessionId === "string" &&
        row.sessionId &&
        ["default", "acceptEdits", "bypassPermissions"].includes(row.mode) &&
        !next.has(row.sessionId)
      )
        next.set(row.sessionId, row.mode);
    }
    for (const [sessionId, mode] of this.awaitingDesktop) {
      if (next.get(sessionId) === mode) this.awaitingDesktop.delete(sessionId);
      else next.set(sessionId, mode);
    }
    super.clear();
    for (const [sessionId, mode] of next) super.set(sessionId, mode);
  }
}
