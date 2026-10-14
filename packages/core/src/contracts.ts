/**
 * Single source of truth for every externally visible contract version.
 *
 * Hosts report this table from `initialize` and `/health` so clients and the
 * services repository can decide compatibility from data instead of package
 * versions. Values that must stay literal for the browser-safe renderer bundle
 * (Desktop `shared/panel-apps.ts`, the `chat` package) are pinned to this table
 * by a drift test in Desktop main.
 */
export const CONTRACTS = Object.freeze({
  /** AgentServer JSON-RPC. "1" is today's unversioned surface; v2 adds "2.0". */
  agentProtocol: Object.freeze({
    supported: Object.freeze(["1"] as const),
    preferred: "1" as const,
  }),
  panelApi: 14,
  cloudManagementAuthority: 2,
  cloudBrowserAuthority: 1,
  relayProtocol: 1,
  desktopControl: 1,
  /** Declared now; the mobile WS hello starts carrying it with ch.16 step 1.5. */
  mobileRemote: 1,
  /** Output-journal segment storage manifest/pin `version: 1` (session/output-journal-storage.ts). */
  outputJournal: 1,
} as const);

export type Contracts = typeof CONTRACTS;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Compile-time only: widening a value to `number`/`string` fails typecheck.
// Downstream `typeof X` usages (e.g. DESKTOP_CONTROL_PROTOCOL_VERSION) rely on literal types.
export type _ContractLiteralTypes = [
  Expect<Equal<typeof CONTRACTS.panelApi, 14>>,
  Expect<Equal<typeof CONTRACTS.cloudManagementAuthority, 2>>,
  Expect<Equal<typeof CONTRACTS.cloudBrowserAuthority, 1>>,
  Expect<Equal<typeof CONTRACTS.relayProtocol, 1>>,
  Expect<Equal<typeof CONTRACTS.desktopControl, 1>>,
  Expect<Equal<typeof CONTRACTS.mobileRemote, 1>>,
  Expect<Equal<typeof CONTRACTS.outputJournal, 1>>,
  Expect<Equal<typeof CONTRACTS.agentProtocol.supported, readonly ["1"]>>,
  Expect<Equal<typeof CONTRACTS.agentProtocol.preferred, "1">>,
];
