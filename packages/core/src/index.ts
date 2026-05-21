/**
 * @cjhyy/code-shell-core — POC entrypoint.
 *
 * This file is a stub during Phase 1.1 of the monorepo split. Real
 * exports (Engine, ToolRegistry, HookRegistry, protocol types, ...)
 * move here in Phase 1.2.
 */

export const CORE_PACKAGE_VERSION = "0.4.0-poc.0";

export interface PocSanityCheck {
  /** Anything — used by packages/cli to verify cross-package type wiring. */
  readonly ok: true;
  readonly emittedFrom: "@cjhyy/code-shell-core";
}

export function pocSanityCheck(): PocSanityCheck {
  return { ok: true, emittedFrom: "@cjhyy/code-shell-core" };
}
