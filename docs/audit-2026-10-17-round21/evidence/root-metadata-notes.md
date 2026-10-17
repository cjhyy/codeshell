# Root symbol anchor metadata correction

Before independent review, Root used `rg -n '^export function ...'` on the actual slug source and corrected two report links from an in-function line to the declaration: normalize 17→16, managedBranchPrefixes 51→49. Both previous anchors were in bounds, but the declarations are more precise. Only Markdown anchors changed; source, fixture, first raw/exit, preflight and product execution remained unchanged. This was metadata refinement, not a failed dynamic test or a rerun.
