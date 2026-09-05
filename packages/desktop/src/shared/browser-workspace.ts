/**
 * Which PAGES a Session operates on, as distinct from which LOGIN it uses.
 *
 * Phase 1 separated login state (the profile) from the Session. This is the
 * other half of shared-auth: two Sessions in one project share a profile — so a
 * login done in one is available in the other — while each keeps its own
 * workspace, so they never fight over each other's tabs.
 *
 * Both were previously the same key (`bucket`), which is why neither could vary
 * independently. See docs/todo/browser-profile-workspace-lease-design.md §2.
 */

import { browserProfileIdForBucket, resolveBrowserProfileId } from "./browser-profile.js";
import { sanitizeBrowserBucket } from "./browser-partition.js";

/** A set of pages and their navigation state. */
export interface BrowserWorkspace {
  id: string;
  /** The login identity these pages are viewed as. */
  profileId: string;
}

/** Which workspace a Session drives. */
export interface SessionBrowserBinding {
  sessionId: string;
  workspaceId: string;
  profileId: string;
}

/**
 * The workspace a Session gets by default: its own, derived from the bucket.
 *
 * Deliberately per-Session, unlike the profile. Sharing pages is a separate
 * feature (`shared-workspace`) that nothing needs yet; sharing login is the
 * default because that is what users actually want.
 */
export function workspaceIdForBucket(bucket: string): string {
  return `w:${sanitizeBrowserBucket(bucket)}`;
}

/**
 * Session ↔ workspace bindings.
 *
 * Kept as a plain in-memory registry with no persistence and no Electron
 * types: the desktop holds one instance, and a server would hold its own (see
 * §7.2 — only TabControl actually needs shared storage, because only it must
 * be mutually exclusive across processes).
 */
export class BrowserWorkspaceRegistry {
  private readonly bySession = new Map<string, SessionBrowserBinding>();
  private readonly sessionsByWorkspace = new Map<string, Set<string>>();

  /** Bind a Session to its own workspace for `bucket`. */
  bind(sessionId: string, bucket: string, chosenProfileId?: unknown): SessionBrowserBinding {
    return this.bindTo(
      sessionId,
      workspaceIdForBucket(bucket),
      // Record the profile actually in use. Re-deriving the project default
      // later would report an isolated Session as sharing.
      chosenProfileId === undefined
        ? browserProfileIdForBucket(bucket)
        : resolveBrowserProfileId(bucket, chosenProfileId),
    );
  }

  /** Bind a Session to an existing workspace (the `shared-workspace` seam). */
  bindTo(sessionId: string, workspaceId: string, profileId: string): SessionBrowserBinding {
    this.unbind(sessionId);
    const binding: SessionBrowserBinding = { sessionId, workspaceId, profileId };
    this.bySession.set(sessionId, binding);
    let members = this.sessionsByWorkspace.get(workspaceId);
    if (!members) {
      members = new Set();
      this.sessionsByWorkspace.set(workspaceId, members);
    }
    members.add(sessionId);
    return binding;
  }

  /** The binding for a Session, or undefined — never a guess. */
  bindingFor(sessionId: string): SessionBrowserBinding | undefined {
    return this.bySession.get(sessionId);
  }

  /** Sessions currently bound to a workspace. Single-writer needs this. */
  sessionsFor(workspaceId: string): string[] {
    return [...(this.sessionsByWorkspace.get(workspaceId) ?? [])];
  }

  /** Forget every binding. For host/test teardown. */
  clear(): void {
    this.bySession.clear();
    this.sessionsByWorkspace.clear();
  }

  /** Drop a Session's binding. A no-op when it was never bound. */
  unbind(sessionId: string): void {
    const existing = this.bySession.get(sessionId);
    if (!existing) return;
    this.bySession.delete(sessionId);
    const members = this.sessionsByWorkspace.get(existing.workspaceId);
    if (!members) return;
    members.delete(sessionId);
    // Drop the empty set so the map cannot grow without bound on a long run.
    if (members.size === 0) this.sessionsByWorkspace.delete(existing.workspaceId);
  }
}
