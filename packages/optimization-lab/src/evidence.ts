import { z } from "zod";
import { mutateJsonFile } from "@cjhyy/code-shell-core/extension";
import { join } from "node:path";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { readBoundedFile } from "./store.js";
import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";
import type { EvalCase } from "./contracts/eval-case.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(512);
const BlockSchema = z
  .object({
    kind: z.enum(["input", "output", "tool", "correction", "attachment"]),
    eventId: id.nullable(),
    text: z.string().max(32768),
    hash,
    originalBytes: z.number().int().nonnegative().safe(),
    bytes: z.number().int().nonnegative().max(32768),
    truncated: z.boolean(),
    redactions: z.array(z.string().max(128)).max(16),
  })
  .strict();
const RunSchema = z
  .object({
    runId: id,
    sessionId: id.nullable(),
    source: z.enum(["managed_run", "session_receipt"]),
    blocks: z.array(BlockSchema).max(50),
    missingEvidence: z.array(z.string().min(1).max(500)).max(32),
    truncated: z.boolean(),
    historicalConfiguration: z.literal("unavailable"),
  })
  .strict();
const ContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectKey: z.string().regex(/^[a-f0-9]{16}$/),
    importedAt: z.string().datetime(),
    redactionVersion: z.literal("lab_evidence_v1"),
    purpose: z.literal("problem_source_only"),
    runs: z.array(RunSchema).min(1).max(20),
  })
  .strict();
export const EvidenceBundleSchema = ContentSchema.extend({ bundleHash: hash });
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
export interface EvidenceSourceRun {
  runId: string;
  sessionId: string | null;
  source: "managed_run" | "session_receipt";
  blocks: Array<{
    kind: z.infer<typeof BlockSchema>["kind"];
    eventId: string | null;
    text: string;
  }>;
  missingEvidence: string[];
  truncated: boolean;
}

/** Best-effort secret removal precedes truncation; human privacy review remains required. */
export function redactEvidenceText(text: string): { text: string; redactions: string[] } {
  const redactions = new Set<string>();
  const replace = (pattern: RegExp, label: string, replacement = "[REDACTED]") => {
    text = text.replace(pattern, () => {
      redactions.add(label);
      return replacement;
    });
  };
  replace(
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "private_key",
  );
  replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.~=-]+/gi, "authorization");
  replace(
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g,
    "known_key",
  );
  replace(
    /(["']?(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\n]+)/gi,
    "secret_field",
  );
  replace(/https?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, "url_credentials");
  replace(/data:[^\s;"']+;base64,[A-Za-z0-9+/=]+/gi, "inline_binary");
  replace(
    /([?&](?:token|key|api_key|access_token|refresh_token|secret|signature)=)[^&#\s"']+/gi,
    "url_secret",
  );
  return { text, redactions: [...redactions].sort() };
}

function boundedUtf8(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  return (
    new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.subarray(0, limit - 3))
      .replace(/\ufffd$/u, "") + "…"
  );
}

/** Host supplies only explicitly selected, project-checked records; no IO or model calls. */
export function buildEvidenceBundle(
  projectKey: string,
  sources: EvidenceSourceRun[],
  now = new Date(),
): EvidenceBundle {
  const runs = sources.map((source) => ({
    runId: source.runId,
    sessionId: source.sessionId,
    source: source.source,
    blocks: [
      ...source.blocks.filter((block) => block.kind === "input" || block.kind === "output"),
      ...source.blocks.filter((block) => block.kind !== "input" && block.kind !== "output"),
    ]
      .slice(0, 50)
      .map((block) => {
        const redacted = redactEvidenceText(block.text);
        const text = boundedUtf8(redacted.text, 32768);
        return {
          ...block,
          text,
          hash: sha256Hex(text),
          originalBytes: Buffer.byteLength(block.text),
          bytes: Buffer.byteLength(text),
          truncated: text !== redacted.text,
          redactions: redacted.redactions,
        };
      }),
    missingEvidence: [
      ...new Set([
        "Historical request/model/tool configuration snapshot is unavailable; this evidence is a problem source, not a historical replay.",
        ...source.missingEvidence,
      ]),
    ].slice(0, 32),
    truncated: source.truncated || source.blocks.length > 50,
    historicalConfiguration: "unavailable" as const,
  }));
  const content = ContentSchema.parse({
    schemaVersion: 1,
    projectKey,
    importedAt: now.toISOString(),
    redactionVersion: "lab_evidence_v1",
    purpose: "problem_source_only",
    runs,
  });
  return verifyEvidenceBundle({ ...content, bundleHash: sha256Hex(canonicalJson(content)) });
}

export function verifyEvidenceBundle(raw: unknown): EvidenceBundle {
  if (Buffer.byteLength(canonicalJson(raw)) > 2 * 1024 * 1024)
    throw new Error("Evidence bundle exceeds limit");
  const bundle = EvidenceBundleSchema.parse(raw);
  const { bundleHash, ...content } = bundle;
  if (
    new Set(bundle.runs.map((run) => run.runId)).size !== bundle.runs.length ||
    sha256Hex(canonicalJson(content)) !== bundleHash
  )
    throw new Error("Evidence bundle identity mismatch");
  for (const run of bundle.runs)
    for (const block of run.blocks)
      if (sha256Hex(block.text) !== block.hash || Buffer.byteLength(block.text) !== block.bytes)
        throw new Error("Evidence block integrity mismatch");
  return bundle;
}

/** Called only after the Host's preview confirmation. Historical output is never an answer key. */
export function importEvidenceBundle(
  root: string,
  projectKey: string,
  raw: unknown,
): { bundle: EvidenceBundle; cases: EvalCase[] } {
  const bundle = verifyEvidenceBundle(raw);
  if (bundle.projectKey !== projectKey) throw new Error("Evidence project mismatch");
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const evidenceRoot = join(root, "evidence");
  if (!existsSync(evidenceRoot)) mkdirSync(evidenceRoot, { mode: 0o700 });
  for (const path of [root, evidenceRoot]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe evidence store");
  }
  const path = join(root, "evidence", `${bundle.bundleHash}.json`);
  mutateJsonFile<EvidenceBundle | undefined, void>(path, {
    parse: (text) => (text === undefined ? undefined : verifyEvidenceBundle(JSON.parse(text))),
    serialize: (value) => canonicalJson(value),
    maxBytes: 2 * 1024 * 1024,
    mode: 0o600,
    mutation: (current) => {
      if (current && canonicalJson(current) !== canonicalJson(bundle))
        throw new Error("Evidence artifact conflict");
      return current ? { result: undefined } : { value: bundle, result: undefined };
    },
  });
  return {
    bundle,
    cases: bundle.runs.map((run) => ({
      id: `evidence-${sha256Hex(run.runId).slice(0, 16)}`,
      version: 1,
      sourceGroupId: `run-${sha256Hex(run.sessionId ?? run.runId).slice(0, 24)}`,
      provenance: "real",
      caseRole: "target_failure",
      split: "dev",
      input:
        run.blocks.find((block) => block.kind === "input")?.text ||
        "[Input unavailable: review the selected evidence before creating a runnable case.]",
      fixtureRefs: [],
      rubric: [],
      hardAssertions: [],
      readiness: "analysis_only",
      missingEvidence: [
        "Confirm intended input, allowed material, expected outcome and independent evaluation criteria before running.",
        ...(run.truncated || run.blocks.some((block) => block.truncated)
          ? ["Selected evidence was truncated."]
          : []),
        ...run.missingEvidence,
      ].slice(0, 32),
      evidence: {
        bundleHash: bundle.bundleHash,
        runId: run.runId,
        purpose: "problem_source_only",
        blockHashes: run.blocks.map((block) => block.hash),
      },
    })),
  };
}

export function verifyEvidenceReferences(
  root: string,
  projectKey: string,
  cases: EvalCase[],
): void {
  const cache = new Map<string, EvidenceBundle>();
  for (const item of cases) {
    if (!item.evidence) continue;
    const ref = item.evidence;
    let bundle = cache.get(ref.bundleHash);
    if (!bundle) {
      const directory = join(root, "evidence");
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe evidence store");
      const text = readBoundedFile(join(directory, `${ref.bundleHash}.json`), 2 * 1024 * 1024);
      if (!text) throw new Error("Imported evidence artifact unavailable");
      bundle = verifyEvidenceBundle(JSON.parse(text));
      if (bundle.bundleHash !== ref.bundleHash || bundle.projectKey !== projectKey)
        throw new Error("Evidence project or hash mismatch");
      cache.set(ref.bundleHash, bundle);
    }
    const run = bundle.runs.find((run) => run.runId === ref.runId);
    if (
      !run ||
      canonicalJson(run.blocks.map((block) => block.hash)) !== canonicalJson(ref.blockHashes) ||
      item.sourceGroupId !== `run-${sha256Hex(run.sessionId ?? run.runId).slice(0, 24)}` ||
      item.provenance !== "real"
    )
      throw new Error("Evidence case provenance mismatch");
  }
}
