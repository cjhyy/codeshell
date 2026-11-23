import type { EvidenceBundle } from "@cjhyy/code-shell-capability-optimization-lab";

export interface LabProjectScope {
  projectId: string;
  cwd: string;
}

export interface LabProjectFiles {
  skills(): Promise<unknown[]>;
  evidence(runIds: string[]): Promise<EvidenceBundle>;
  readPicked(path: string): Promise<string>;
  writePicked(path: string, content: string, revalidate: () => Promise<void>): Promise<void>;
}

export interface LabFileOperations {
  "lab/skills": { input: LabProjectScope; result: unknown[] };
  "lab/evidence": { input: LabProjectScope & { runIds: string[] }; result: EvidenceBundle };
  "lab/readPicked": { input: LabProjectScope & { path: string }; result: string };
  "lab/writePicked": { input: LabProjectScope & { path: string; content: string }; result: void };
}
