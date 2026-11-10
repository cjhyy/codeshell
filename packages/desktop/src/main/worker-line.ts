/** A parse result also represents invalid JSON, so it never triggers a second parse. */
export interface ParsedWorkerLine {
  readonly line: string;
  /** Shared by downstream readers; copy the affected fields before projecting changes. */
  readonly message: unknown;
}

export function parseWorkerLine(line: string): ParsedWorkerLine {
  try {
    return { line, message: JSON.parse(line) };
  } catch {
    return { line, message: undefined };
  }
}
