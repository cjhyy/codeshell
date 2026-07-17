/**
 * Stable, minimal composition entry for hosts that load the Pet capability.
 *
 * Keep implementation helpers on the compatibility root; new hosts should
 * depend only on this factory.
 */
export { createPetCapability } from "./capability.js";
