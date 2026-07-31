/**
 * Codex-specific pieces. The transport, the session store and the spawn env are
 * shared with Claude Code (see `../shared/`) — both runtimes speak HTTP MCP with
 * a bearer token, so there is one bridge implementation, not two.
 */
export { CodexEventTranslator } from "./event-translator.js";
export type { CodexEventTranslatorOptions } from "./event-translator.js";
