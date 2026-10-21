/** Durable physical admission, separate from the journal's immutable cursor domain. */
import { fstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  capturePersistentFileIdentity,
  isValidPersistentFileIdentity,
  matchesPersistentFileIdentity,
  type PersistentFileIdentity,
} from "./persistent-file-identity.js";

export interface OutputJournalBinding {
  version: 1;
  root: string;
  directory: PersistentFileIdentity;
  anchor: PersistentFileIdentity;
  journalIdentity: string;
  coverageIdentity: string;
}
const hex = /^[a-f0-9]{64}$/;
export function isValidOutputJournalBinding(value: unknown): value is OutputJournalBinding {
  const binding = value as OutputJournalBinding | undefined;
  return Boolean(
    binding &&
    binding.version === 1 &&
    typeof binding.root === "string" &&
    isValidPersistentFileIdentity(binding.directory) &&
    isValidPersistentFileIdentity(binding.anchor) &&
    typeof binding.journalIdentity === "string" &&
    hex.test(binding.journalIdentity) &&
    typeof binding.coverageIdentity === "string" &&
    hex.test(binding.coverageIdentity),
  );
}

export function validateOutputJournalBinding(
  root: string,
  directory: string,
  anchorFd: number | undefined,
  binding: OutputJournalBinding,
): void {
  if (
    !isValidOutputJournalBinding(binding) ||
    binding.root !== realpathSync(root) ||
    !matchesPersistentFileIdentity(directory, binding.directory) ||
    (anchorFd !== undefined &&
      !matchesPersistentFileIdentity(
        join(directory, "output-journal.jsonl"),
        binding.anchor,
        fstatSync(anchorFd, { bigint: true }),
      ))
  )
    throw new Error("Output journal persistent file identity changed");
}

export function createOutputJournalBinding(
  root: string,
  directory: string,
  anchorFd: number,
  journalIdentity: string,
  coverageIdentity: string,
): OutputJournalBinding {
  return {
    version: 1,
    root: realpathSync(root),
    directory: capturePersistentFileIdentity(directory),
    anchor: capturePersistentFileIdentity(
      join(directory, "output-journal.jsonl"),
      fstatSync(anchorFd, { bigint: true }),
    ),
    journalIdentity,
    coverageIdentity,
  };
}
