/**
 * A tool owner's external-runtime declaration. Declaring compatibility alone
 * grants nothing: the composed contract must also match the reviewed snapshot.
 */
export interface ExternalToolCompatibility {
  kind: "self-contained" | "host-loopback";
  status: "exposed" | "deferred" | "excluded";
  reason: string;
  /** OR of argument patterns, with an AND of anchored fields in each pattern. */
  argsPatterns?: readonly Readonly<Record<string, string>>[];
  /** Host-owned controller, separate from a native Engine goal acknowledgement. */
  requires?: "goal-controller";
}

/** Checked-in approval of a specific declaration, schema and execution policy. */
export interface ExternalToolReview extends ExternalToolCompatibility {
  tool: string;
  contractFingerprint: string;
}
