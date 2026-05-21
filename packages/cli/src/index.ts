/**
 * @cjhyy/code-shell-cli — POC entrypoint.
 *
 * Exists only to prove the cross-package import path works during
 * Phase 1.1 of the monorepo split. Real CLI bin + UI move here in
 * Phase 1.2.
 */

import { pocSanityCheck, type PocSanityCheck } from "@cjhyy/code-shell-core";

export function describeCorePoc(): string {
  const r: PocSanityCheck = pocSanityCheck();
  return `cli sees core: ok=${r.ok} from=${r.emittedFrom}`;
}
