/**
 * Shim for CC's utils/semver — re-exports semver comparison helpers.
 */

import { gte as semverGte, lt as semverLt } from 'semver';

export function gte(a: string, b: string): boolean {
  return semverGte(a, b);
}

export function lt(a: string, b: string): boolean {
  return semverLt(a, b);
}
