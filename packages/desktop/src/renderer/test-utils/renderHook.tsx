/**
 * Shim — the mini-DOM + renderHook test harness moved to
 * packages/web/src/test-utils (the web package's hook tests need it too, and
 * test-utils are not part of the web package's published surface, so this
 * re-export uses a relative path rather than the package entry).
 */
export * from "../../../../web/src/test-utils/renderHook";
