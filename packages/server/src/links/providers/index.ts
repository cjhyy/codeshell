import {
  registerLocalLinkProviders,
  getLocalLinkProvider,
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
  const providers = createDefaultLinkProviders();
  // Two product module copies may share one Core registry (e.g. a host/plugin
  // composition). Preserve explicitly installed implementations instead of
  // overwriting them or treating the second default composition as an error.
  register(
    register === registerLocalLinkProviders
      ? providers.filter((provider) => !getLocalLinkProvider(provider.id))
      : providers,
  );
  installed.add(register);
}

/** Loaded by the existing trusted worker module factory mechanism. */
export function createLinkProviderModule(): AgentModule {
  installDefaultLinkProviders();
  return { id: "codeshell-link-providers" };
}
