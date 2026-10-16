import {
  registerLocalLinkProviders,
  type AgentModule,
  type LocalLinkProviderSpec,
} from "@cjhyy/code-shell-core/extension";
import { createDefaultLinkProviders } from "./defaults.js";

export { createDefaultLinkProviders } from "./defaults.js";
type Registrar = (providers: readonly LocalLinkProviderSpec[]) => void;
const installed = new WeakSet<Registrar>();

/** Explicit product composition; custom SDK callers may supply their own registrar. */
export function installDefaultLinkProviders(
  register: Registrar = registerLocalLinkProviders,
): void {
  if (installed.has(register)) return;
  register(createDefaultLinkProviders());
  installed.add(register);
}

/** Loaded by the existing trusted worker module factory mechanism. */
export function createLinkProviderModule(): AgentModule {
  installDefaultLinkProviders();
  return { id: "codeshell-link-providers" };
}
