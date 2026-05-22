/**
 * Shim for CC's utils/semver — re-exports semver comparison helpers.
 */

import { gte as semverGte, gt as semverGt, lt as semverLt } from 'semver';

export function gte(a: string, b: string): boolean {
  return semverGte(a, b);
}

export function gt(a: string, b: string): boolean {
  return semverGt(a, b);
}

export function lt(a: string, b: string): boolean {
  return semverLt(a, b);
}
