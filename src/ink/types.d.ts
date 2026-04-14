/**
 * Type declarations for packages used by the ink engine
 * that don't ship their own types.
 */

declare module "bidi-js" {
  const bidi: {
    getReorderSegments(text: string, direction: "ltr" | "rtl"): Array<[number, number]>;
    getMirroredCharacter(char: string): string | null;
    getEmbeddingLevels(text: string, direction: "ltr" | "rtl"): { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> };
  };
  export default bidi;
}

declare module "code-excerpt" {
  interface CodeLine {
    line: number;
    value: string;
  }
  export function CodeExcerpt(source: string, line: number, options?: { around?: number }): CodeLine[] | undefined;
  function codeExcerpt(source: string, line: number, options?: { around?: number }): CodeLine[] | undefined;
  export default codeExcerpt;
}

declare module "stack-utils" {
  class StackUtils {
    static nodeInternals(): RegExp[];
    constructor(options?: { cwd?: string; internals?: RegExp[] });
    clean(stack: string): string;
    parseLine(line: string): {
      file?: string;
      line?: number;
      column?: number;
      function?: string;
    } | null;
  }
  export default StackUtils;
}

declare module "react-reconciler" {
  import type { ReactNode } from "react";
  function createReconciler(config: any): any;
  export default createReconciler;
  export type FiberRoot = any;
  export type HostConfig = any;
}

declare module "react-reconciler/constants.js" {
  export const ConcurrentRoot: number;
  export const LegacyRoot: number;
  export const ContinuousEventPriority: number;
  export const DefaultEventPriority: number;
  export const DiscreteEventPriority: number;
  export const NoEventPriority: number;
}

declare module "auto-bind" {
  function autoBind<T extends object>(self: T): T;
  export default autoBind;
}
