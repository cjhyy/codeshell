import { z } from "zod";
import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";

export const STRATEGY_VERSION = "reflect_once_v1";
const ProposalSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            body: z.string().min(1),
            explanation: z.string().min(1).max(6000),
            sourceCaseIds: z.array(z.string().min(1).max(64)).min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();

export interface Candidate {
  schemaVersion: 1;
  body: string;
  bodyHash: string;
  markdown: string;
  parentBodyHash: string;
  strategyVersion: typeof STRATEGY_VERSION;
  explanation: string;
  sourceCaseIds: string[];
}

export function validateCandidates(
  text: string,
  options: {
    parentBodyHash: string;
    frontmatterOriginal: string;
    devCaseIds: string[];
    maxCandidates: number;
    maxBodyBytes: number;
    maxContextBytes: number;
  },
): Candidate[] {
  const proposal = ProposalSchema.parse(JSON.parse(text));
  if (proposal.candidates.length > options.maxCandidates)
    throw new Error("candidate limit exceeded");
  const seen = new Set<string>();
  return proposal.candidates.map((item) => {
    if (item.body.startsWith("---") || /\u0000/.test(item.body))
      throw new Error("candidate must contain only a valid Skill body");
    const bytes = Buffer.byteLength(item.body, "utf8");
    if (bytes > options.maxBodyBytes || bytes > options.maxContextBytes)
      throw new Error("candidate body exceeds frozen limits");
    if (item.sourceCaseIds.some((id) => !options.devCaseIds.includes(id)))
      throw new Error("candidate cites an unapproved source");
    const bodyHash = sha256Hex(item.body);
    if (bodyHash === options.parentBodyHash || seen.has(bodyHash))
      throw new Error("candidate body is unchanged or duplicated");
    seen.add(bodyHash);
    return {
      schemaVersion: 1,
      body: item.body,
      bodyHash,
      markdown: options.frontmatterOriginal + item.body,
      parentBodyHash: options.parentBodyHash,
      strategyVersion: STRATEGY_VERSION,
      explanation: item.explanation,
      sourceCaseIds: [...new Set(item.sourceCaseIds)].sort(),
    };
  });
}

export function candidateHash(candidate: Candidate): string {
  return sha256Hex(canonicalJson(candidate));
}
