/**
 * Shared utility types.
 */

/**
 * Recursively makes all properties of T readonly.
 */
export type DeepImmutable<T> = T extends (infer R)[]
  ? ReadonlyArray<DeepImmutable<R>>
  : T extends object
    ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
    : T
