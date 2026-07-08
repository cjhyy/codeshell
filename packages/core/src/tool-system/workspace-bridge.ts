import type { SessionWorkspace } from "../types.js";

/**
 * WorkspaceBridge — host-backed session workspace switching.
 *
 * Desktop implements this through Electron main so model-initiated switches use
 * the same service path as the UI workspace switcher. Undefined in headless or
 * non-desktop contexts.
 */
export interface WorkspaceBridge {
  switch(target: string): Promise<SessionWorkspace>;
}
