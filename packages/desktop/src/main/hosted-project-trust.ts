import type {
  CallShellBusiness,
  ShellBusinessOperations,
} from "../shared/shell-business-contracts.js";
import { claimBusinessCommit } from "../host/composition/business-calls.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import { holdProjectTrust, setTrust, type TrustLevel } from "./trust-store.js";

export async function writeHostedProjectTrust({
  input,
  permit,
}: {
  input: ShellBusinessOperations["trust/set"]["input"];
  permit: Int32Array;
}) {
  const path = await requireRendererProjectPath(input.path);
  await setTrust(path, input.level, () => claimBusinessCommit(permit));
  return true;
}

/** Publish only the worker's committed state to synchronous Native grant checks.
 * A read queued on the same serial writer also settles a change whose caller
 * left after the atomic permit was consumed but before its reply arrived. */
export async function updateHostedProjectTrust(
  call: CallShellBusiness,
  path: string,
  level: TrustLevel,
  signal: AbortSignal,
) {
  const release = holdProjectTrust(path, level);
  let confirmed: TrustLevel | "unknown" = "unknown";
  try {
    await call("trust/set", { path, level }, signal);
  } finally {
    try {
      confirmed = await call("trust/readProjection", path);
    } finally {
      release(confirmed);
    }
  }
}
