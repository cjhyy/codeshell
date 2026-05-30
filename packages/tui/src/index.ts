/**
 * @cjhyy/code-shell-tui — TUI package entrypoint.
 *
 * Phase 1.2 migration: real CLI bin at ./cli/main.ts
 * Currently only re-exports VERSION; UI components are imported directly
 * from their module paths, not from this entrypoint.
 */

export { VERSION } from "@cjhyy/code-shell-core";
