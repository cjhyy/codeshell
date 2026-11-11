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
  /**
   * A Host-owned executor the Host must register and opt into: the Goal
   * controller (separate from a native Engine goal acknowledgement), or the
   * Mimi notice/report host (NotifyMe, ReportToMimi run in the Host process).
   */
  requires?: "goal-controller" | "mimi-host";
}

/** Checked-in approval of a specific declaration, schema and execution policy. */
export interface ExternalToolReview extends ExternalToolCompatibility {
  tool: string;
  contractFingerprint: string;
}
