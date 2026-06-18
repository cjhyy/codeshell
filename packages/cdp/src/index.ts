/**
 * @cjhyy/code-shell-cdp — environment-agnostic CDP browser action layer.
 *
 * Drive a browser target (click/type/select/press_key/hover/scroll + raw
 * observe) through an injected CdpSender. No Playwright, no launcher, no agent
 * loop, zero runtime dependencies. Works in Electron (webContents.debugger),
 * Node/Bun (raw CDP WebSocket), or any host that can send one CDP command.
 */

export { CdpActionsDriver, CONTENT_CHAR_CAP, EXTRACT_LINK_CAP, MAX_IMAGE_DIM, buildExtractScript, cleanPageText } from "./driver.js";
export { planKeySequence, keyInfo, normalizeKey, MODIFIER_BITS } from "./keymap.js";
export type { KeyInfo, KeyEvent } from "./keymap.js";
export type { CdpSender, PageInfo } from "./sender.js";
export type {
  AXNode,
  RawSnapshot,
  CdpActionResult,
  CdpContentResult,
  CdpLink,
  CdpImage,
  CdpVideo,
  CdpExtractResult,
  CdpImageData,
} from "./types.js";
